import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
const workflow = readFileSync(path.join(root, '.github/workflows/build-electron.yml'), 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

describe('desktop update metadata pipeline', () => {
  it('does not exclude production modules needed by the packaged main process', () => {
    expect(builder).not.toMatch(/^\s*-\s*["']?!node_modules(?:\/\*\*\/\*)?["']?\s*$/mu);
  });
  it('keeps the updater at runtime and pins the official GitHub provider', () => {
    // Given the packaged main process needs electron-updater at runtime
    // When package and builder metadata are read
    // Then the dependency and immutable official repository are present
    expect(packageJson.dependencies?.['electron-updater']).toMatch(/^\^6\./);
    expect(builder).toContain('provider: github');
    expect(builder).toContain('owner: qiyuanhuakai');
    expect(builder).toContain('repo: opencode-visualizer-cn');
    expect(builder).toContain('releaseType: draft');
  });

  it('publishes updater manifests and requires blockmaps only for Windows packages', () => {
    // Given AppImage embeds its blockmap while NSIS emits a sidecar
    // When the release job collects installer artifacts
    // Then Linux requires its manifest without inventing a sidecar, while Windows keeps both
    const linuxJob = workflow.slice(
      workflow.indexOf('build-linux-x64:'),
      workflow.indexOf('bridge-installers:'),
    );
    const windowsJobs = workflow.slice(
      workflow.indexOf('build-windows-x64:'),
      workflow.indexOf('build-linux-x64:'),
    );
    expect(workflow).toContain('dist-electron/latest.yml');
    expect(workflow).toContain('dist-electron/latest-linux.yml');
    expect(workflow).toContain('artifacts/**/*.yml');
    expect(workflow).toContain('artifacts/**/*.blockmap');
    expect(workflow).toContain("Test-Path 'dist-electron/latest.yml'");
    expect(workflow).toContain("test -f dist-electron/latest-linux.yml");
    expect(windowsJobs).toContain('dist-electron/*.blockmap');
    expect(linuxJob).not.toContain('dist-electron/*.blockmap');
  });

  it('gives Windows arm64 a non-colliding stable channel manifest', () => {
    // Given x64 and arm64 are built on separate native runners
    // When their metadata is uploaded into one GitHub release
    // Then arm64 is renamed to the channel requested by the arm64 app
    expect(workflow).toContain('Rename updater manifest for arm64 channel');
    expect(workflow).toContain('latest-arm64.yml');
  });
});
