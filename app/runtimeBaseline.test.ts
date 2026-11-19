import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

interface PackManifest {
  readonly files: readonly { readonly path: string }[];
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

  it('ships every shared/runtime module the packaged bridge and electron code imports', () => {
    const files = packageJson.files as string[];
    const covered = (candidate: string) =>
      files.some((entry) => candidate === entry || candidate.startsWith(`${entry}/`));
    const packagedRoots = ['bridge', 'electron'];
    const packagedSources = ['vis_bridge.js', 'server.js'];
    for (const dir of packagedRoots) {
      for (const entry of readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!/\.(cjs|mjs|js)$/.test(entry.name)) continue;
        packagedSources.push(path.relative(root, path.join(entry.parentPath ?? path.join(root, dir), entry.name)));
      }
    }
    const relativeImport = /from\s+'(\.[^']+)'/g;
    const unresolved: string[] = [];
    for (const source of packagedSources) {
      const text = readFileSync(path.join(root, source), 'utf8');
      for (const [, specifier] of text.matchAll(relativeImport)) {
        const resolved = path.relative(root, path.normalize(path.join(path.dirname(path.join(root, source)), specifier)));
        // npm always ships package.json regardless of the files whitelist.
        if (resolved === 'package.json') continue;
        if (!covered(resolved)) unresolved.push(`${source} -> ${specifier}`);
      }
    }
    expect(unresolved, 'published files whitelist must cover every relative import').toEqual([]);
    expect(files).toContain('shared/runtime');
  });

  it('packs the bridge entrypoints together with their shared/runtime dependencies', () => {
    const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(packed.status, packed.stderr).toBe(0);
    const [manifest] = JSON.parse(packed.stdout) as PackManifest[];
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toContain('vis_bridge.js');
    expect(paths).toContain('bridge/bridgeRuntime.js');
    expect(paths).toContain('shared/runtime/protocol.js');
    expect(paths).toContain('shared/runtime/identity.js');
  });
});
