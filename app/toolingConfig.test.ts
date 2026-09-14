import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const packageJson: unknown = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const tailwindCss = readFileSync(path.join(repoRoot, 'app/styles/tailwind.css'), 'utf8');
const postcssModule: unknown = await import(
  pathToFileURL(path.join(repoRoot, 'postcss.config.mjs')).href
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) {
  throw new Error('package.json must define scripts');
}
if (!isRecord(packageJson.devDependencies)) {
  throw new Error('package.json must define devDependencies');
}
if (!isRecord(postcssModule) || !isRecord(postcssModule.default)) {
  throw new Error('postcss.config.mjs must export a configuration object');
}

const scripts = packageJson.scripts;
const devDependencies = packageJson.devDependencies;
const postcssConfig = postcssModule.default;

function commandTokens(scriptName: string): readonly string[] {
  const script = scripts[scriptName];
  if (typeof script !== 'string') throw new Error(`missing package script: ${scriptName}`);
  return script.trim().split(/\s+/u);
}

describe('tooling config contract', () => {
  describe('format scripts', () => {
    it('defines format:check as a read-only oxfmt check', () => {
      const tokens = commandTokens('format:check');
      expect(tokens[0]).toBe('oxfmt');
      expect(tokens).toContain('--check');
      expect(tokens).not.toContain('--fix');
      expect(tokens).not.toContain('--write');
    });

    it('keeps the interactive format script', () => {
      expect(commandTokens('format')[0]).toBe('oxfmt');
    });
  });

  describe('type-aware lint', () => {
    it('installs both lint executables used by the configured gate', () => {
      expect(devDependencies.oxlint).toEqual(expect.any(String));
      expect(devDependencies['oxlint-tsgolint']).toEqual(expect.any(String));
    });

    it('runs oxlint and strict Vue type-checking in the lint gate', () => {
      const tokens = commandTokens('lint');
      expect(tokens[0]).toBe('oxlint');
      expect(tokens).toContain('vue-tsc');
      expect(tokens).toContain('--noEmit');
    });
  });

  describe('Tailwind integration', () => {
    it('installs the PostCSS adapter and typography plugin', () => {
      expect(devDependencies.tailwindcss).toEqual(expect.any(String));
      expect(devDependencies['@tailwindcss/postcss']).toEqual(expect.any(String));
      expect(devDependencies['@tailwindcss/typography']).toEqual(expect.any(String));
    });

    it('keeps the renderer stylesheet directives intact', () => {
      expect(tailwindCss).toContain("@import 'tailwindcss';");
      expect(tailwindCss).toContain('@plugin "@tailwindcss/typography";');
      expect(tailwindCss).toContain('@source "../**/*.{vue,ts}";');
      expect(tailwindCss).toContain('@theme {');
    });

    it('loads the actual PostCSS config with the Tailwind adapter enabled', () => {
      expect(postcssConfig.plugins).toMatchObject({ '@tailwindcss/postcss': {} });
    });
  });
});
