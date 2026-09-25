import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('passes the real SQLite worker and IPC integration suite', () => {
  const result = spawnSync(
    process.execPath,
    ['--test', path.resolve(__dirname, '../scripts/qa/native-session-storage.test.mjs')],
    { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 35_000);
