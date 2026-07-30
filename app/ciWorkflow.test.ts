import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve(__dirname, '../.github/workflows/build-electron.yml');
const workflow = readFileSync(workflowPath, 'utf8');

describe('complete CI workflow', () => {
  it('runs the complete validation and packaging pipeline for every pull request', () => {
    expect(workflow).toMatch(/\n  pull_request:\s*\n/);
    expect(workflow).toContain('run: pnpm lint');
    expect(workflow).toContain('run: pnpm test');
    expect(workflow).toContain('run: pnpm build');
    expect(workflow).toContain('run: pnpm bridge:build');
  });

  it('exposes one aggregate required check for branch protection', () => {
    expect(workflow).toContain('complete-ci:');
    expect(workflow).toContain('name: Complete CI');
    expect(workflow).toContain('needs: [validate, build, bridge-installers]');
    expect(workflow).toContain('if: always()');
  });

  it('publishes only native bridge installers with VIS releases', () => {
    expect(workflow).toContain('run: pnpm bridge:package-installer');
    expect(workflow).toContain('dist-bridge/installers/*.deb');
    expect(workflow).toContain('dist-bridge/installers/*.pkg');
    expect(workflow).toContain('dist-bridge/installers/*.exe');
    expect(workflow).not.toContain('dist-bridge/vis_bridge*');
    expect(workflow).toContain('runner: ubuntu-24.04-arm');
    expect(workflow).toContain('runner: windows-11-arm');
    expect(workflow).toContain('runner: macos-15-intel');
  });

  it('exercises each native installer through the installed PATH command', () => {
    expect(workflow).toContain('name: Exercise Linux installer');
    expect(workflow).toContain('name: Exercise macOS installer');
    expect(workflow).toContain('name: Exercise Windows installer');
    expect(workflow).toContain('vis_bridge --help');
  });
});
