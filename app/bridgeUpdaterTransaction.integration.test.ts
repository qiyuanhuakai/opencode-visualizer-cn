// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildVisBridgeBinary } from '../scripts/build-vis-bridge.mjs';
import { packageVisBridgeInstaller } from '../scripts/package-vis-bridge-installer.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const nativeQaEnabled = process.env.VIS_BRIDGE_NATIVE_UPDATE_QA === '1'
  && process.platform === 'linux'
  && (process.arch === 'x64' || process.arch === 'arm64')
  && existsSync('/usr/bin/docker')
  && existsSync('/usr/bin/dpkg-deb');

describe.runIf(nativeQaEnabled)('vis_bridge native updater transaction', () => {
  it('upgrades an older SEA package while stopping its daemon tree without restart', async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'vis-bridge-native-update-'));
    const containerName = `vis-bridge-updater-transaction-${process.pid}`;
    try {
      stageFixtureDependencies(fixtureRoot);
      const oldInstaller = await buildFixtureInstaller(fixtureRoot, '0.7.12');
      const newInstaller = await buildFixtureInstaller(fixtureRoot, '0.8.0');
      chmodSync(fixtureRoot, 0o755);
      const digest = createHash('sha256').update(readFileSync(newInstaller)).digest('hex');
      const output = execFileSync('docker', [
        'run', '--rm', '--init', '--name', containerName,
        '--volume', `${fixtureRoot}:/fixtures:ro`,
        'debian:bookworm-slim',
        '/bin/bash', '-euxo', 'pipefail', '-c',
        containerTransaction({
          oldInstaller: `/fixtures/${path.relative(fixtureRoot, oldInstaller)}`,
          newInstaller: `/fixtures/${path.relative(fixtureRoot, newInstaller)}`,
          digest,
        }),
      ], { encoding: 'utf8', timeout: 220_000, maxBuffer: 4 * 1024 * 1024 });

      for (const evidence of [
        'OLD_VERSION=0.7.12',
        'UID_MISMATCH=1',
        'UNREADABLE_ROOT_ANCESTOR=1',
        'HOSTED_REJECTED=1',
        'NEW_VERSION=0.8.0',
        'PACKAGE_VERSION=0.8.0',
        'DAEMON_STOPPED=1',
        'NO_RESTART=1',
      ]) expect(output).toContain(evidence);
    } finally {
      spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 280_000);
});

function stageFixtureDependencies(fixtureRoot: string): void {
  const nodeModules = path.join(fixtureRoot, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(path.join(projectRoot, 'node_modules', 'node-pty'), path.join(nodeModules, 'node-pty'));
  mkdirSync(path.join(fixtureRoot, 'bridge'), { recursive: true });
}

async function buildFixtureInstaller(fixtureRoot: string, version: string): Promise<string> {
  writeFileSync(
    path.join(fixtureRoot, 'bridge', 'binaryEntry.js'),
    fixtureEntry(version),
    'utf8',
  );
  await buildVisBridgeBinary(fixtureRoot);
  return packageVisBridgeInstaller(fixtureRoot, {
    version,
    platform: 'linux',
    arch: process.arch,
    format: 'deb',
  });
}

function fixtureEntry(version: string): string {
  const updateCliPath = path.join(projectRoot, 'bridge', 'updateCli.js');
  const transportPath = path.join(projectRoot, 'electron', 'updateTransport.js');
  return `
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBridgeUpdate } from ${JSON.stringify(updateCliPath)};
import { verifyAsset } from ${JSON.stringify(transportPath)};
const version = ${JSON.stringify(version)};
async function main() {
  const [command] = process.argv.slice(2);
  if (command === '--version') return process.stdout.write(version + '\\n');
  if (command === 'child') return setInterval(() => undefined, 1000);
  if (command === 'daemon') {
    const child = spawn(process.execPath, ['child'], { stdio: 'ignore' });
    await writeFile(process.argv[3], process.pid + ' ' + child.pid + '\\n');
    return setInterval(() => undefined, 1000);
  }
  if (command === 'hosted-update') {
    const child = spawnSync(process.execPath, ['update', '--yes'], { env: process.env, stdio: 'inherit' });
    process.exitCode = child.status ?? 1;
    return;
  }
  if (command !== 'update') throw new Error('Unknown fixture command.');
  const assetPath = process.env.VIS_BRIDGE_FIXTURE_ASSET;
  const digest = process.env.VIS_BRIDGE_FIXTURE_SHA256;
  if (!assetPath || !digest) throw new Error('Missing fixture release metadata.');
  const assetStat = await stat(assetPath);
  const asset = {
    name: path.basename(assetPath),
    size: assetStat.size,
    digest: 'sha256:' + digest,
    url: 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/assets/1',
  };
  const transport = {
    getLatestRelease: async () => ({ version: '0.8.0', tag: 'v0.8.0', assets: [asset] }),
    downloadAsset: async () => {
      const directory = await mkdtemp('/tmp/vis-update-');
      await chmod(directory, 0o700);
      const destination = path.join(directory, asset.name);
      await copyFile(assetPath, destination);
      await chmod(destination, 0o600);
      return destination;
    },
    verifyAsset,
    removeFile: async (filePath) => rm(path.dirname(filePath), { recursive: true, force: true }),
    dispose: () => undefined,
  };
  await runBridgeUpdate({ check: false, yes: true }, { currentVersion: version, transport });
}
void main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\\n');
  process.exitCode = 1;
});
`;
}

function containerTransaction(paths: {
  oldInstaller: string;
  newInstaller: string;
  digest: string;
}): string {
  return `
dump_logs() {
  status=$?
  trap - EXIT
  if test "$status" -ne 0; then
    for log in /tmp/hosted.log /tmp/daemon.log /tmp/update.log; do
      if test -f "$log"; then
        printf '\\n=== %s ===\\n' "$log" >&2
        cat "$log" >&2 || true
      fi
    done
  fi
  exit "$status"
}
trap dump_logs EXIT
apt-get update >/dev/null
apt-get install -y --no-install-recommends procps sudo >/dev/null
fixture_uid=$(stat -c %u /fixtures)
if test "$fixture_uid" = '1000'; then updater_uid=1001; else updater_uid=1000; fi
useradd --uid "$updater_uid" --create-home updater
test "$fixture_uid" != "$updater_uid"
printf 'UID_MISMATCH=1\n'
printf 'updater ALL=(root) NOPASSWD: /usr/bin/readlink, /usr/bin/dpkg\\n' >/etc/sudoers.d/updater
chmod 0440 /etc/sudoers.d/updater
dpkg -i ${paths.oldInstaller} >/dev/null
printf 'OLD_VERSION=%s\\n' "$(/usr/bin/vis_bridge --version)"
if runuser -u updater -- /usr/bin/readlink -- /proc/$$/exe >/dev/null 2>&1; then exit 20; fi
printf 'UNREADABLE_ROOT_ANCESTOR=1\\n'
export VIS_BRIDGE_FIXTURE_ASSET=${paths.newInstaller}
export VIS_BRIDGE_FIXTURE_SHA256=${paths.digest}
if runuser -u updater --preserve-environment -- /usr/bin/vis_bridge hosted-update >/tmp/hosted.log 2>&1; then exit 21; fi
test "$(/usr/bin/vis_bridge --version)" = '0.7.12'
printf 'HOSTED_REJECTED=1\\n'
runuser -u updater -- /usr/bin/vis_bridge daemon /tmp/daemon-pids >/tmp/daemon.log 2>&1 &
launcher=$!
for attempt in $(seq 1 100); do test -s /tmp/daemon-pids && break; sleep 0.05; done
test -s /tmp/daemon-pids
runuser -u updater --preserve-environment -- /usr/bin/vis_bridge update --yes >/tmp/update.log 2>&1
read -r daemon_pid child_pid </tmp/daemon-pids
for attempt in $(seq 1 100); do
  test ! -e "/proc/$daemon_pid/exe" && test ! -e "/proc/$child_pid/exe" && break
  sleep 0.05
done
test ! -e "/proc/$daemon_pid/exe"
test ! -e "/proc/$child_pid/exe"
kill "$launcher" 2>/dev/null || true
wait "$launcher" || true
printf 'DAEMON_STOPPED=1\\n'
printf 'NEW_VERSION=%s\\n' "$(/usr/bin/vis_bridge --version)"
printf 'PACKAGE_VERSION=%s\\n' "$(dpkg-query -W -f='\${Version}' vis-bridge)"
for executable in /proc/[0-9]*/exe; do
  test "$(readlink "$executable" 2>/dev/null || true)" != '/usr/bin/vis_bridge'
done
printf 'NO_RESTART=1\\n'
! compgen -G '/tmp/vis-update-*' >/dev/null
cat /tmp/update.log
`;
}
