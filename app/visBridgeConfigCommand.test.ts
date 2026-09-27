import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cliPath = path.resolve(import.meta.dirname, '../vis_bridge.js');

describe('vis_bridge config command', () => {
  it('opens the selected config in EDITOR and returns its exit status', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'vis-bridge-editor-'));
    const configPath = path.join(directory, 'bridge config.json');
    const editorPath = path.join(directory, 'editor.mjs');
    const markerPath = path.join(directory, 'editor-result.json');
    writeFileSync(editorPath, [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const file = process.argv[2];',
      "const config = JSON.parse(readFileSync(file, 'utf8'));",
      'config.nativeServices.codex = false;',
      'writeFileSync(file, JSON.stringify(config));',
      'writeFileSync(process.env.EDITOR_MARKER, file);',
    ].join('\n'));
    try {
      const env = {
        ...process.env,
        EDITOR: `"${process.execPath}" "${editorPath}"`,
        EDITOR_MARKER: markerPath,
        VIS_BRIDGE_CODEX_TOKEN_FILE: '/missing/stale-token-file',
      };
      const opened = spawnSync(process.execPath, [cliPath, 'config', '--config', configPath], {
        env,
        encoding: 'utf8',
      });
      expect(opened.status, opened.stderr).toBe(0);
      expect(readFileSync(markerPath, 'utf8')).toBe(configPath);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).nativeServices.codex).toBe(false);
      const failed = spawnSync(process.execPath, [cliPath, 'config', '--config', configPath], {
        env: { ...env, EDITOR: path.join(directory, 'missing-editor') },
        encoding: 'utf8',
      });
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain('editor');
      expect(existsSync(configPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('opens the active daemon config when no path override is supplied', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'vis-bridge-current-config-'));
    const stateDirectory = path.join(directory, 'state');
    const configPath = path.join(directory, 'active bridge.json');
    const markerPath = path.join(directory, 'opened-path');
    const editorPath = path.join(directory, 'editor.mjs');
    mkdirSync(stateDirectory);
    writeFileSync(path.join(stateDirectory, 'daemon.json'), JSON.stringify({
      version: 1,
      instanceId: 'test-daemon',
      pid: process.pid,
      state: 'running',
      logPath: path.join(stateDirectory, 'daemon.log'),
      launchArgs: [`--config=${configPath}`],
      controlPort: 1,
      controlToken: 'test-control-token',
      failures: [],
    }));
    writeFileSync(editorPath, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.EDITOR_MARKER, process.argv[2]);");
    try {
      const result = spawnSync(process.execPath, [cliPath, 'config'], {
        env: {
          ...process.env,
          VIS_BRIDGE_STATE_DIR: stateDirectory,
          VIS_BRIDGE_CONFIG: '',
          EDITOR: `"${process.execPath}" "${editorPath}"`,
          EDITOR_MARKER: markerPath,
        },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(markerPath, 'utf8')).toBe(configPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('opens a malformed existing config so the editor can repair it', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'vis-bridge-repair-config-'));
    const configPath = path.join(directory, 'bridge.json');
    const editorPath = path.join(directory, 'repair.mjs');
    writeFileSync(configPath, '{ invalid JSON');
    writeFileSync(editorPath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.argv[2], JSON.stringify({ version: 1, nativeServices: { opencode: true, codex: false, 'kimi-web': true }, acpAgents: [] }));",
    ].join('\n'));
    try {
      const result = spawnSync(process.execPath, [cliPath, 'config', '--config', configPath], {
        env: { ...process.env, EDITOR: `"${process.execPath}" "${editorPath}"` },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).nativeServices.codex).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
