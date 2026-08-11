import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_PATH = path.resolve(__dirname, '../package.json');
const POSTCSS_CONFIG_PATH = path.resolve(__dirname, '../postcss.config.mjs');
const TAILWIND_CSS_PATH = path.resolve(__dirname, './styles/tailwind.css');

// Static contract over the Task 9 (electron-major-upgrade) tooling stack:
// the read-only `format:check` script, the oxlint/oxlint-tsgolint type-aware
// pair wiring, and the Tailwind 4.x directives the renderer stylesheet depends
// on. Mirror of viteConfig.test.ts / electronSmokeContract.test.ts (string +
// manifest level, no runtime dependencies).
const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const tailwindCss = readFileSync(TAILWIND_CSS_PATH, 'utf8');
const postcssConfig = readFileSync(POSTCSS_CONFIG_PATH, 'utf8');

describe('tooling config contract', () => {
  describe('format:check', () => {
    it('defines a read-only format:check script (oxfmt --check, never --fix)', () => {
      const script = pkg.scripts['format:check'];
      expect(script).toBeDefined();
      expect(script).toContain('oxfmt');
      expect(script).toContain('--check');
      expect(script).not.toMatch(/--fix|--write|\bformat\b(?!:check)/);
    });

    it('keeps the interactive format script for local formatting', () => {
      expect(pkg.scripts['format']).toContain('oxfmt');
    });
  });

  describe('oxlint / oxlint-tsgolint pair', () => {
    it('keeps both members of the type-aware lint pair in devDependencies', () => {
      expect(pkg.devDependencies['oxlint']).toBeDefined();
      expect(pkg.devDependencies['oxlint-tsgolint']).toBeDefined();
    });

    it('pins oxlint to the stable 1.x line that ships type-aware support', () => {
      // Task 9 registry snapshot: oxlint latest = 1.78.0 (2026-08-11).
      expect(pkg.devDependencies['oxlint']).toMatch(/^\^1\.\d+\.\d+$/);
    });

    it('pins oxlint-tsgolint to the v7 stable line (tracks TypeScript 7.0.2 + 3-digit patch)', () => {
      // Official tsgolint versioning: v7.0.2### = TS 7.0.2 semantics + patch.
      // Task 9 registry snapshot: oxlint-tsgolint latest = 7.0.2001.
      expect(pkg.devDependencies['oxlint-tsgolint']).toMatch(/^\^7\.0\.2\d{3}$/);
    });

    it('keeps the lint gate shape (oxlint + vue-tsc strict)', () => {
      expect(pkg.scripts['lint']).toContain('oxlint');
      expect(pkg.scripts['lint']).toContain('vue-tsc --noEmit');
    });
  });

  describe('tailwind 4.x stack', () => {
    it('keeps tailwindcss and @tailwindcss/postcss on the 4.x line', () => {
      expect(pkg.devDependencies['tailwindcss']).toMatch(/^\^4\./);
      expect(pkg.devDependencies['@tailwindcss/postcss']).toMatch(/^\^4\./);
    });

    it('keeps @tailwindcss/typography on the 0.5.x line', () => {
      expect(pkg.devDependencies['@tailwindcss/typography']).toMatch(/^\^0\.5\./);
    });

    it('keeps the tailwind v4 import, plugin and source directives intact', () => {
      expect(tailwindCss).toContain("@import 'tailwindcss';");
      expect(tailwindCss).toContain('@plugin "@tailwindcss/typography";');
      expect(tailwindCss).toContain('@source "../**/*.{vue,ts}";');
      expect(tailwindCss).toContain('@theme {');
    });

    it('keeps the @tailwindcss/postcss integration in postcss.config.mjs', () => {
      expect(postcssConfig).toContain("'@tailwindcss/postcss'");
    });
  });
});
