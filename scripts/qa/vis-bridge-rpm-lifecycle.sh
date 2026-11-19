#!/bin/sh
set -eu

if [ "${1:-}" = '--container' ]; then
  if [ "$#" -ne 2 ]; then
    printf 'container usage: %s --container <release-rpm>\n' "$0" >&2
    exit 2
  fi

  release_rpm="$2"
  helper='/workspace/scripts/qa/vis-bridge-installer-daemon-qa.mjs'

  start_process_tree() {
    state_directory="$1"
    port="$2"
    evidence_path="$3"
    VIS_BRIDGE_STATE_DIR="$state_directory" /usr/bin/vis_bridge start --port "$port"
    node "$helper" spawn "$state_directory" "$port" "$evidence_path"
  }

  dnf install -y nodejs "$release_rpm"
  rpm -q vis-bridge
  /usr/bin/vis_bridge --version
  printf 'RPM_NORMAL_INSTALL_OK\n'

  dnf install -y rpm-build
  qa_root="$(mktemp -d)"
  trap 'rm -rf "$qa_root"' EXIT INT TERM
  mkdir -p "$qa_root/dist-bridge" "$qa_root/node_modules"
  cp /usr/bin/vis_bridge "$qa_root/dist-bridge/vis_bridge"
  cp -a /usr/lib/vis_bridge/node_modules/node-pty "$qa_root/node_modules/node-pty"
  # The packager re-stages the runtime store worker plus its import closure from
  # the root's source-shaped tree (bridge/runtime/storage/** plus the shared
  # closure), so this QA root must carry the REAL closure the RPM just
  # installed — never a re-implementation. The installed tree keeps that closure
  # under its staged names (bridge/runtime/runtime/** and shared/runtime/**);
  # copying it back into the source-shaped locations is what lets the upgrade
  # build resolve bridge/runtime/storage/runtimeDatabaseWorker.mjs at all.
  # Production staging still requires the worker and is never skipped.
  mkdir -p "$qa_root/bridge/runtime/storage" "$qa_root/shared/runtime"
  for staged in /usr/lib/vis_bridge/bridge/runtime/runtime/*; do
    case "${staged##*/}" in
      vis_bridge_node|vis_bridge_node.exe) continue ;;
    esac
    cp -a "$staged" "$qa_root/bridge/runtime/storage/"
  done
  cp -a /usr/lib/vis_bridge/shared/runtime/. "$qa_root/shared/runtime/"
  if [ ! -f "$qa_root/bridge/runtime/storage/runtimeDatabaseWorker.mjs" ]; then
    printf 'the installed bridge shipped no runtime store worker closure\n' >&2
    exit 1
  fi
  upgrade_rpm="$(
    node --input-type=module - "$qa_root" <<'NODE'
import { packageVisBridgeInstaller } from '/workspace/scripts/package-vis-bridge-installer.mjs';

const rootDirectory = process.argv[2];
const installerPath = await packageVisBridgeInstaller(rootDirectory, {
  platform: 'linux',
  arch: process.arch,
  format: 'rpm',
  version: '9999.0.0',
});
process.stdout.write(installerPath);
NODE
  )"

  start_process_tree /tmp/vis-bridge-rpm-install-state 23199 /tmp/vis-bridge-rpm-upgrade.json
  dnf upgrade -y "$upgrade_rpm"
  node "$helper" assert-stopped /tmp/vis-bridge-rpm-install-state 23199 /tmp/vis-bridge-rpm-upgrade.json
  test "$(rpm -q --qf '%{VERSION}' vis-bridge)" = '9999.0.0'
  printf 'RPM_UPGRADE_LIFECYCLE_OK\n'

  start_process_tree /tmp/vis-bridge-rpm-remove-state 23200 /tmp/vis-bridge-rpm-remove.json
  dnf remove -y vis-bridge
  node "$helper" assert-stopped /tmp/vis-bridge-rpm-remove-state 23200 /tmp/vis-bridge-rpm-remove.json
  printf 'RPM_REMOVE_LIFECYCLE_OK\n'
  exit 0
fi

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  printf 'usage: %s <release-rpm>\n' "$0" >&2
  exit 2
fi

root_directory="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
release_rpm="$(readlink -f "$1")"
case "$release_rpm" in
  "$root_directory"/*) ;;
  *)
    printf 'release RPM must be inside %s\n' "$root_directory" >&2
    exit 2
    ;;
esac

docker run --rm --init \
  -v "$root_directory:/workspace:ro" \
  fedora:42 \
  bash /workspace/scripts/qa/vis-bridge-rpm-lifecycle.sh \
  --container "/workspace/${release_rpm#"$root_directory"/}"
