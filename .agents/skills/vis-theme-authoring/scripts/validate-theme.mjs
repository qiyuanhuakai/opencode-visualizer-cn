#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const builtin = args[0] === '--builtin';
const fileArg = builtin ? args[1] : args[0];

if (!fileArg || args.length !== (builtin ? 2 : 1)) {
  console.error('Usage: node .agents/skills/vis-theme-authoring/scripts/validate-theme.mjs [--builtin] path/to/theme.json');
  process.exitCode = 2;
} else {
  try {
    const filePath = resolve(process.cwd(), fileArg);
    const content = await readFile(filePath, 'utf8');
    const browser = new Window();
    globalThis.CSS = browser.CSS;

    const result = await build({
      stdin: {
        contents: [
          "export { parseExternalThemeFileText } from './app/utils/themeRegistry.ts';",
          "export { validateExternalThemeFile } from './app/utils/themeFileValidation.ts';",
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: 'vis-theme-validation-entry.ts',
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`;
    const { parseExternalThemeFileText, validateExternalThemeFile } = await import(moduleUrl);
    const theme = builtin ? JSON.parse(content) : parseExternalThemeFileText(content);
    if (builtin) validateExternalThemeFile(theme);

    console.log(`Valid Vis ${builtin ? 'built-in' : 'importable'} theme: ${theme.id} (${theme.label})`);
    await browser.close();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
