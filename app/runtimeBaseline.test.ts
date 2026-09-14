import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const workspaceYaml = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
const bridgeBuildScript = readFileSync(path.join(root, 'scripts/build-vis-bridge.mjs'), 'utf8');
const buildWorkflow = readFileSync(path.join(root, '.github/workflows/build-electron.yml'), 'utf8');
const deployWorkflow = readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
const requireFromRepo = createRequire(path.join(root, 'runtime-baseline-test.cjs'));
const yamlModule: unknown = requireFromRepo('./node_modules/.pnpm/node_modules/js-yaml');

interface WorkflowStep {
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDocument {
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

function isYamlModule(value: unknown): value is { readonly load: (text: string) => unknown } {
  return typeof value === 'object' && value !== null && 'load' in value;
}

if (!isYamlModule(yamlModule)) throw new Error('js-yaml loader is unavailable');
const yaml = yamlModule;

function setupNodeSteps(source: string): readonly WorkflowStep[] {
  const parsed = yaml.load(source) as WorkflowDocument;
  return Object.values(parsed.jobs ?? {}).flatMap(({ steps }) =>
    (steps ?? []).filter(({ uses }) => uses?.startsWith('actions/setup-node@')),
  );
}

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
    for (const [name, source] of [
      ['build-electron', buildWorkflow],
      ['deploy', deployWorkflow],
    ] as const) {
      const steps = setupNodeSteps(source);
      expect(steps.length, `${name} must contain setup-node steps`).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.with?.['node-version'], `${name} setup-node version`).toBe('24');
      }
    }
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
