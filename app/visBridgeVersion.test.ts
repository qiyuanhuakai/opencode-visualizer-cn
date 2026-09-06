import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
import packageInfo from '../package.json';

it('reports the installed bridge version without reading daemon configuration or starting services', () => {
  const stdout = execFileSync(process.execPath, [path.resolve(import.meta.dirname, '../vis_bridge.js'), '--version'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, VIS_BRIDGE_PORT: 'invalid', VIS_BRIDGE_CODEX_TOKEN_FILE: '/nonexistent/secret' },
  });
  expect(stdout.trim()).toBe(packageInfo.version);
});
