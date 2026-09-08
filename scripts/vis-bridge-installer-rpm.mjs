import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { createLinuxMaintainerScript } from './vis-bridge-installer-lifecycle.mjs';
import { stageLinuxRuntimePayload } from './vis-bridge-installer-posix.mjs';

const execFileAsync = promisify(execFile);

function rpmArchitecture(architecture) {
  return architecture === 'x64' ? 'x86_64' : 'aarch64';
}

function rpmVersion(version) {
  return version.replaceAll('-', '~');
}

function rpmLiteral(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%');
}

function rpmMacroValue(value) {
  return value.replaceAll('%', '%%');
}

function rpmLifecycleLines() {
  return createLinuxMaintainerScript().trimEnd().split('\n').slice(1, -1);
}

export function createLinuxRpmSpec({ version, architecture, payloadPath }) {
  const lifecycleLines = rpmLifecycleLines().map((line) => line.replaceAll('%', '%%'));
  return [
    '%global _enable_debug_packages 0',
    '%global _build_id_links none',
    '%global _no_recompute_build_ids 1',
    '%global __os_install_post %{nil}',
    '%global __brp_strip %{nil}',
    '%global __brp_strip_comment_note %{nil}',
    '%global __brp_strip_lto %{nil}',
    '%global __brp_strip_static_archive %{nil}',
    '%{?python_disable_dependency_generator}',
    'Name: vis-bridge',
    `Version: ${rpmVersion(version)}`,
    'Release: 1',
    'Summary: Local process supervisor and protocol bridge for Vis',
    'License: MIT',
    `BuildArch: ${architecture}`,
    'Requires(pre): /bin/sh, /usr/bin/pgrep, /usr/bin/readlink, /usr/bin/kill, /usr/bin/sleep',
    'Requires(preun): /bin/sh, /usr/bin/pgrep, /usr/bin/readlink, /usr/bin/kill, /usr/bin/sleep',
    '',
    '%description',
    'Local process supervisor and protocol bridge for Vis.',
    '',
    '%prep',
    '',
    '%build',
    '',
    '%install',
    'rm -rf "%{buildroot}"',
    'mkdir -p "%{buildroot}"',
    `cp -a "${rpmLiteral(payloadPath)}/." "%{buildroot}/"`,
    '',
    '%pre',
    ...lifecycleLines,
    'exit 0',
    '',
    '%preun',
    'if [ "$1" -eq 0 ]; then',
    ...lifecycleLines.map((line) => `  ${line}`),
    'fi',
    'exit 0',
    '',
    '%files',
    '%defattr(-,root,root,-)',
    '%attr(0755,root,root) /usr/bin/vis_bridge',
    '/usr/lib/vis_bridge/node_modules/node-pty',
    '',
  ].join('\n');
}

export async function packageLinuxRpmInstaller(paths, target, rootDirectory, normalizedVersion) {
  const payloadPath = path.join(paths.workspacePath, 'payload');
  const topDirectory = path.join(paths.workspacePath, 'rpmbuild');
  await stageLinuxRuntimePayload({
    payloadPath,
    binaryPath: paths.binaryPath,
    rootDirectory,
    target,
  });
  await Promise.all(
    ['BUILD', 'BUILDROOT', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS'].map((directory) =>
      mkdir(path.join(topDirectory, directory), { recursive: true }),
    ),
  );
  const specPath = path.join(topDirectory, 'SPECS', 'vis-bridge.spec');
  await writeFile(
    specPath,
    createLinuxRpmSpec({
      version: normalizedVersion(target.version),
      architecture: rpmArchitecture(target.arch),
      payloadPath,
    }),
    'utf8',
  );
  await execFileAsync('rpmbuild', [
    '-bb',
    '--define',
    `_topdir ${rpmMacroValue(topDirectory)}`,
    '--define',
    `_rpmdir ${rpmMacroValue(paths.installerDirectory)}`,
    '--define',
    `_rpmfilename ${path.basename(paths.installerPath)}`,
    specPath,
  ]);
}
