import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const workspaceYaml = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
const bridgeBuildScript = readFileSync(path.join(root, 'scripts/build-vis-bridge.mjs'), 'utf8');
const buildWorkflow = readFileSync(path.join(root, '.github/workflows/build-electron.yml'), 'utf8');
const deployWorkflow = readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');

describe('runtime-baseline', () => {
  it('locks the package manager to the approved pnpm 11 line', () => {
    expect(packageJson.packageManager).toMatch(/^pnpm@11\./);
    expect(packageJson.packageManager).not.toMatch(/^pnpm@10\./);
  });

  it('declares the node 24 LTS engine range in package.json', () => {
    expect(packageJson.engines.node).toBe('>=24 <25');
  });

  it('pins @types/node to the latest 24.x line', () => {
    expect(packageJson.devDependencies['@types/node']).toMatch(/^\^?24\./);
  });

  it('runs every CI workflow step on node 24', () => {
    // Every setup-node step (one per job: validate, five electron lanes, bridge)
    // must pin node 24 — count-agnostic so adding lanes cannot silently downgrade.
    expect(buildWorkflow.match(/uses: actions\/setup-node@v4/g)).toHaveLength(7);
    expect(buildWorkflow.match(/node-version: '24'/g)).toHaveLength(7);
    expect(deployWorkflow.match(/node-version: '24'/g)).toHaveLength(1);
    expect(buildWorkflow).not.toContain("node-version: '22'");
    expect(deployWorkflow).not.toContain("node-version: '22'");
  });

  it('targets the SEA bundle at node 24', () => {
    expect(bridgeBuildScript).toContain("target: 'node24'");
    expect(bridgeBuildScript).not.toContain("target: 'node22'");
  });

  it('replaces legacy pnpm build-policy keys with allowBuilds', () => {
    expect(workspaceYaml).not.toContain('onlyBuiltDependencies');
    expect(workspaceYaml).not.toContain('ignoredBuiltDependencies');
    expect(workspaceYaml).toContain('allowBuilds');
  });
});
