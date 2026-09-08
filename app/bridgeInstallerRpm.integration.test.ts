import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { packageVisBridgeInstaller } from '../scripts/package-vis-bridge-installer.mjs';

const rpmToolsAvailable =
  process.platform === 'linux' &&
  (process.arch === 'x64' || process.arch === 'arm64') &&
  existsSync('/usr/bin/rpmbuild') &&
  existsSync('/usr/bin/rpm') &&
  existsSync('/usr/bin/rpm2cpio') &&
  existsSync('/usr/bin/cpio');

describe.runIf(rpmToolsAvailable)('vis_bridge RPM package', () => {
  it('contains the executable runtime payload, metadata, permissions, and lifecycle scriptlets', async () => {
    const architecture = process.arch as 'x64' | 'arm64';
    const rpmArchitecture = architecture === 'x64' ? 'x86_64' : 'aarch64';
    // Given: a minimal native bridge payload with an executable node-pty prebuild.
    const root = mkdtempSync(path.join(tmpdir(), 'vis-bridge-rpm-test-'));
    const bridgePath = path.join(root, 'dist-bridge', 'vis_bridge');
    const nodePtyPath = path.join(root, 'node_modules', 'node-pty');
    mkdirSync(path.join(nodePtyPath, 'lib'), { recursive: true });
    mkdirSync(path.join(nodePtyPath, 'prebuilds', `linux-${architecture}`), { recursive: true });
    mkdirSync(path.dirname(bridgePath), { recursive: true });
    writeFileSync(bridgePath, '#!/bin/sh\nexit 0\n');
    writeFileSync(path.join(nodePtyPath, 'lib', 'index.js'), 'export {};\n');
    const prebuildPath = path.join(nodePtyPath, 'prebuilds', `linux-${architecture}`, 'pty.node');
    writeFileSync(prebuildPath, 'native-payload\n');
    writeFileSync(path.join(nodePtyPath, 'package.json'), '{"name":"node-pty"}\n');
    writeFileSync(path.join(nodePtyPath, 'LICENSE'), 'MIT\n');
    chmodSync(bridgePath, 0o755);
    chmodSync(prebuildPath, 0o755);

    // When: the production packager builds a real native-architecture RPM.
    const rpmPath = await packageVisBridgeInstaller(root, {
      version: 'v1.2.3',
      platform: 'linux',
      arch: architecture,
      format: 'rpm',
    });

    // Then: rpm tooling observes the public package contract and extracted bytes.
    expect(path.basename(rpmPath)).toBe(`VisBridge-1.2.3-${architecture}-Linux.rpm`);
    expect(
      execFileSync('rpm', ['-qp', '--qf', '%{NAME} %{VERSION} %{ARCH}', rpmPath], {
        encoding: 'utf8',
      }),
    ).toBe(`vis-bridge 1.2.3 ${rpmArchitecture}`);
    const files = execFileSync('rpm', ['-qpl', rpmPath], { encoding: 'utf8' });
    expect(files).toContain('/usr/bin/vis_bridge');
    expect(files).toContain(
      `/usr/lib/vis_bridge/node_modules/node-pty/prebuilds/linux-${architecture}/pty.node`,
    );
    const scripts = execFileSync('rpm', ['-qp', '--scripts', rpmPath], { encoding: 'utf8' });
    expect(scripts).toContain('preinstall scriptlet');
    expect(scripts).toContain('preuninstall scriptlet');
    expect(scripts).not.toContain('postuninstall scriptlet');

    const extractionPath = path.join(root, 'extracted');
    mkdirSync(extractionPath);
    const archive = execFileSync('rpm2cpio', [rpmPath]);
    execFileSync('cpio', ['-idmu'], {
      cwd: extractionPath,
      input: archive,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const extractedBridge = path.join(extractionPath, 'usr', 'bin', 'vis_bridge');
    const extractedPrebuild = path.join(
      extractionPath,
      'usr',
      'lib',
      'vis_bridge',
      'node_modules',
      'node-pty',
      'prebuilds',
      `linux-${architecture}`,
      'pty.node',
    );
    expect(readFileSync(extractedBridge, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(readFileSync(extractedPrebuild, 'utf8')).toBe('native-payload\n');
    expect(statSync(extractedBridge).mode & 0o777).toBe(0o755);
    expect(statSync(extractedPrebuild).mode & 0o777).toBe(0o755);
  });
});
