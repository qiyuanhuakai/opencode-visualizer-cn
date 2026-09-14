import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const builderSource = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
const workflowSource = readFileSync(
  path.join(root, '.github/workflows/build-electron.yml'),
  'utf8',
);
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  readonly dependencies?: Readonly<Record<string, string>>;
};
const requireFromRepo = createRequire(path.join(root, 'desktop-metadata-test.cjs'));
const yamlModule: unknown = requireFromRepo('./node_modules/.pnpm/node_modules/js-yaml');

interface BuilderDocument {
  readonly files?: readonly string[];
  readonly publish?: {
    readonly provider?: string;
    readonly owner?: string;
    readonly repo?: string;
    readonly releaseType?: string;
  };
}

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
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
const builder = yamlModule.load(builderSource) as BuilderDocument;
const workflow = yamlModule.load(workflowSource) as WorkflowDocument;

function localSpecifiersFromSource(modulePath: string, source: string): readonly string[] {
  const result = ts.transpileModule(source, {
    compilerOptions: { allowJs: true },
    fileName: modulePath,
    reportDiagnostics: true,
  });
  if (result.diagnostics?.some(({ category }) => category === ts.DiagnosticCategory.Error)) {
    throw new Error(`invalid JavaScript module: ${modulePath}`);
  }
  const file = ts.createSourceFile(
    modulePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith('.')
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return specifiers;
}

function localSpecifiers(modulePath: string): readonly string[] {
  return localSpecifiersFromSource(modulePath, readFileSync(path.join(root, modulePath), 'utf8'));
}

function localModuleClosure(entryPath: string): readonly string[] {
  const pending = [entryPath];
  const closure = new Set<string>();
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (modulePath === undefined || closure.has(modulePath)) continue;
    closure.add(modulePath);
    for (const specifier of localSpecifiers(modulePath)) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(modulePath), specifier),
      );
      pending.push(path.posix.extname(resolved) === '' ? `${resolved}.js` : resolved);
    }
  }
  return [...closure];
}

function matchesBuilderPattern(modulePath: string, pattern: string): boolean {
  if (pattern.endsWith('/**/*')) return modulePath.startsWith(pattern.slice(0, -4));
  const wildcard = pattern.indexOf('*');
  if (wildcard === -1) return modulePath === pattern;
  return (
    modulePath.startsWith(pattern.slice(0, wildcard)) &&
    modulePath.endsWith(pattern.slice(wildcard + 1))
  );
}

function packagedByBuilder(modulePath: string): boolean {
  const patterns = builder.files ?? [];
  const included = patterns.some(
    (pattern) => !pattern.startsWith('!') && matchesBuilderPattern(modulePath, pattern),
  );
  const excluded = patterns.some(
    (pattern) => pattern.startsWith('!') && matchesBuilderPattern(modulePath, pattern.slice(1)),
  );
  return included && !excluded;
}

function steps(jobName: string): readonly WorkflowStep[] {
  return workflow.jobs?.[jobName]?.steps ?? [];
}

function uploadedPaths(jobName: string): readonly string[] {
  const upload = steps(jobName).find(({ uses }) => uses?.startsWith('actions/upload-artifact@'));
  const paths = upload?.with?.path;
  return typeof paths === 'string' ? paths.trim().split(/\s+/u) : [];
}

describe('desktop update metadata pipeline', () => {
  it('rejects malformed modules instead of accepting an incomplete import graph', () => {
    expect(() =>
      localSpecifiersFromSource('electron/broken.js', "import { from './missing.js'"),
    ).toThrow('invalid JavaScript module');
  });

  it('does not exclude production runtime dependencies from the package', () => {
    expect(builder.files ?? []).not.toContain('!node_modules');
    expect(builder.files ?? []).not.toContain('!node_modules/**/*');
  });

  it('packages the compiler-discovered local module closure of the Electron entry point', () => {
    const unpackagedModules = localModuleClosure('electron/main.js').filter(
      (modulePath) => !packagedByBuilder(modulePath),
    );
    expect(unpackagedModules).toEqual([]);
  });

  it('keeps the updater at runtime and pins the official GitHub provider', () => {
    expect(packageJson.dependencies?.['electron-updater']).toEqual(expect.any(String));
    expect(builder.publish).toEqual({
      provider: 'github',
      owner: 'qiyuanhuakai',
      repo: 'opencode-visualizer-cn',
      releaseType: 'draft',
    });
  });

  it('publishes updater manifests and requires blockmaps only for Windows packages', () => {
    for (const jobName of ['build-windows-x64', 'build-windows-arm64'] as const) {
      const paths = uploadedPaths(jobName);
      expect(paths.some((file) => file.endsWith('.yml'))).toBe(true);
      expect(paths.some((file) => file.endsWith('.blockmap'))).toBe(true);
      expect(steps(jobName).some(({ run }) => run?.includes('*.blockmap'))).toBe(true);
    }
    const linuxPaths = uploadedPaths('build-linux-x64');
    expect(linuxPaths).toContain('dist-electron/latest-linux.yml');
    expect(linuxPaths.some((file) => file.endsWith('.blockmap'))).toBe(false);
    expect(steps('build-linux-x64').some(({ run }) => run?.includes('latest-linux.yml'))).toBe(
      true,
    );
    const release = steps('release').find(({ uses }) => uses === 'softprops/action-gh-release@v2');
    const releaseFiles = release?.with?.files;
    expect(releaseFiles).toEqual(expect.any(String));
    expect(releaseFiles).toContain('artifacts/**/*.yml');
    expect(releaseFiles).toContain('artifacts/**/*.blockmap');
  });

  it('gives Windows arm64 a non-colliding stable channel manifest', () => {
    const renameStep = steps('build-windows-arm64').find(
      ({ name }) => name === 'Rename updater manifest for arm64 channel',
    );
    expect(renameStep?.run).toContain('latest-arm64.yml');
    expect(uploadedPaths('build-windows-arm64')).toContain('dist-electron/latest-arm64.yml');
  });
});
