// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('vis_bridge updater process boundary', () => {
  it.each(['update', 'upgrade'])('prints isolated help for the %s alias without daemon configuration reads', (command) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'vis-bridge-update-help-'));
    temporaryDirectories.push(directory);
    const stateDirectory = path.join(directory, 'daemon-state');
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../vis_bridge.js'), command, '--help'], {
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        VIS_BRIDGE_PORT: 'invalid',
        VIS_BRIDGE_CODEX_TOKEN_FILE: '/nonexistent/secret',
        VIS_BRIDGE_STATE_DIR: stateDirectory,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('vis_bridge update [--check] [--yes|-y]');
    expect(existsSync(stateDirectory)).toBe(false);
  });

  it('rejects unsupported updater flags with a nonzero exit and no daemon startup', () => {
    const result = spawnSync(process.execPath, [
      path.resolve(import.meta.dirname, '../vis_bridge.js'), 'update', '--url', 'https://example.com',
    ], { encoding: 'utf8', timeout: 5_000 });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Unknown option '--url'/u);
  });
});
