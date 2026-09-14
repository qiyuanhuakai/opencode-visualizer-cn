import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const normalizeTestFile = (root, file) => {
  const normalized = file.split('\\').join('/');
  return normalized.startsWith('app/')
    ? normalized
    : relative(root, resolve(file)).split('\\').join('/');
};

export const testKey = ({ file, name, occurrence }) => `${file}\u0000${name}\u0000${occurrence}`;

export const addOccurrences = (root, rows) => {
  const counts = new Map();
  return rows.map((row) => {
    const file = normalizeTestFile(root, row.file);
    const identity = `${file}\u0000${row.name}`;
    const occurrence = (counts.get(identity) ?? 0) + 1;
    counts.set(identity, occurrence);
    return { file, name: row.name, occurrence };
  });
};

export const readVitestList = (root) => {
  const vitestCli = resolve(dirname(fileURLToPath(import.meta.resolve('vitest'))), '../vitest.mjs');
  return JSON.parse(
    execFileSync(process.execPath, [vitestCli, 'list', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
};
