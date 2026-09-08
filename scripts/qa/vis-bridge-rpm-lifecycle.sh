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
