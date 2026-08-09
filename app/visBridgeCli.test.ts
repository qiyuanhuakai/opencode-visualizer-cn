import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  collectStartupFailures,
  createDaemonInvocation,
} from '../bridge/daemonController.js';
import {
  fingerprintDaemonCredentials,
  mergeDaemonRestartArgs,
  prepareDaemonLaunch,
} from '../bridge/daemonCredentials.js';
import { parseCliOptions } from '../vis_bridge';

describe('vis_bridge lifecycle commands', () => {
  it('maps legacy no-command and option-first invocations to daemon start', () => {
    expect(parseCliOptions([], {})).toMatchObject({ command: 'start', serverArgs: [] });
    expect(parseCliOptions(['--port', '23120'], {})).toMatchObject({
      command: 'start',
      port: 23120,
      serverArgs: ['--port', '23120'],
    });
  });

  it('separates direct secrets from persisted daemon launch arguments', () => {
    expect(
      prepareDaemonLaunch(
        ['--port', '23004', '--bridge-token=bridge-secret', '--upstream-token', 'upstream-secret'],
        {
          bridgeToken: 'bridge-secret',
          upstreamAuthorization: 'Bearer upstream-secret',
        },
      ),
    ).toEqual({
      launchArgs: ['--port', '23004'],
      requiredSecrets: ['bridgeToken', 'upstreamAuthorization'],
      secrets: {
        bridgeToken: 'bridge-secret',
        upstreamAuthorization: 'Bearer upstream-secret',
      },
    });
  });

  it('fingerprints both bridge and upstream credentials without persisting them', () => {
    const controlToken = 'control-token';
    const baseline = fingerprintDaemonCredentials(controlToken, {
      bridgeToken: 'bridge-token',
      upstreamAuthorization: 'Bearer upstream-token',
    });
    expect(fingerprintDaemonCredentials(controlToken, {
      bridgeToken: 'different-bridge-token',
      upstreamAuthorization: 'Bearer upstream-token',
    })).not.toBe(baseline);
    expect(fingerprintDaemonCredentials(controlToken, {
      bridgeToken: 'bridge-token',
      upstreamAuthorization: 'Bearer different-upstream-token',
    })).not.toBe(baseline);
    expect(baseline).not.toContain('bridge-token');
    expect(baseline).not.toContain('upstream-token');
  });

  it('merges credential-only restart overrides without duplicating persisted secret markers', () => {
    expect(
      mergeDaemonRestartArgs(
        ['--host=127.0.0.1', '--port=23120', '--upstream-token-file=/tmp/old-token'],
        ['--bridge-token=ipc'],
        ['bridgeToken'],
      ),
    ).toEqual([
      '--host=127.0.0.1',
      '--port=23120',
      '--upstream-token-file=/tmp/old-token',
      '--bridge-token=ipc',
    ]);
  });

  it('parses start options without treating the lifecycle command as a server argument', () => {
    expect(parseCliOptions(['start', '--port', '23120'], {})).toMatchObject({
      command: 'start',
      port: 23120,
      serverArgs: ['--port', '23120'],
    });
  });

  it('rejects server options on stop', () => {
    expect(() => parseCliOptions(['stop', '--port', '23120'], {})).toThrow(
      'vis_bridge stop does not accept --port',
    );
  });

  it('reports both native-service and ACP startup failures', () => {
    expect(
      collectStartupFailures({
        services: [
          {
            kind: 'native',
            name: 'OpenCode',
            state: 'error',
            error: 'opencode executable missing',
          },
        ],
        acpAgents: [
          {
            kind: 'acp',
            name: 'Broken ACP',
            state: 'error',
            error: 'agent executable missing',
          },
          { kind: 'acp', name: 'Healthy ACP', state: 'running' },
        ],
      }),
    ).toEqual([
      { kind: 'native', name: 'OpenCode', error: 'opencode executable missing' },
      { kind: 'acp', name: 'Broken ACP', error: 'agent executable missing' },
    ]);
  });

  it('recognizes a relative SEA argv path as the executable itself', () => {
    expect(
      createDaemonInvocation({
        entryPath: './dist-bridge/vis_bridge',
        execPath: path.resolve('dist-bridge/vis_bridge'),
        serverArgs: ['--port', '23120'],
      }),
    ).toEqual({
      command: path.resolve('dist-bridge/vis_bridge'),
      args: ['__daemon', '--port', '23120'],
    });
  });

  it('does not read a stale token file when a higher-priority authorization is present', () => {
    expect(
      parseCliOptions(['start'], {
        VIS_BRIDGE_CODEX_AUTHORIZATION: 'Basic dXNlcjpwYXNz',
        VIS_BRIDGE_CODEX_TOKEN_FILE: '/missing/stale-token-file',
      }),
    ).toMatchObject({ upstreamAuthorization: 'Basic dXNlcjpwYXNz' });
    expect(
      parseCliOptions(['--help'], {
        VIS_BRIDGE_CODEX_TOKEN_FILE: '/missing/stale-token-file',
      }),
    ).toMatchObject({ help: true, serverArgs: [] });
  });

  it('materializes environment-derived options as secret-free daemon arguments', () => {
    const options = parseCliOptions(['start'], {
      VIS_BRIDGE_HOST: '127.0.0.2',
      VIS_BRIDGE_PORT: '23113',
      VIS_BRIDGE_PATH: '/env-path',
      VIS_BRIDGE_CODEX_WS_URL: 'ws://127.0.0.1:4513',
      VIS_BRIDGE_CONFIG: '/tmp/env-config.json',
      VIS_BRIDGE_TOKEN: 'bridge-secret',
      VIS_BRIDGE_CODEX_AUTHORIZATION: 'Basic dXNlcjpwYXNz',
    });

    expect(options).toMatchObject({
      hasDaemonConfiguration: true,
      daemonArgs: [
        '--host=127.0.0.2',
        '--port=23113',
        '--path=/env-path',
        '--target=ws://127.0.0.1:4513',
        '--config=/tmp/env-config.json',
        '--bridge-token=ipc',
        '--upstream-token=ipc',
      ],
    });
    if (!('daemonArgs' in options)) throw new Error('Expected daemon arguments.');
    expect(JSON.stringify(options.daemonArgs)).not.toContain('bridge-secret');
    expect(JSON.stringify(options.daemonArgs)).not.toContain('dXNlcjpwYXNz');
  });

  it('persists the selected upstream token-file source instead of converting it to a direct secret', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'vis-bridge-token-file-'));
    const tokenPath = path.join(directory, 'token');
    writeFileSync(tokenPath, 'file-token\n');
    try {
      expect(parseCliOptions(['start', '--upstream-token-file', tokenPath], {})).toMatchObject({
        daemonArgs: expect.arrayContaining([`--upstream-token-file=${tokenPath}`]),
        daemonSecretArgs: [`--upstream-token-file=${tokenPath}`],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects target URLs that could expose embedded credentials through process arguments', () => {
    for (const target of [
      'wss://user:password@example.test/codex',
      'wss://example.test/codex?access_token=secret',
      'wss://example.test/codex#secret',
    ]) {
      expect(() => parseCliOptions(['start', '--target', target], {})).toThrow(
        'must not include credentials, query parameters, or fragments',
      );
    }
  });

  it('rejects malformed target URLs before daemon lifecycle changes begin', () => {
    expect(() => parseCliOptions(['restart', '--target', 'not-a-websocket-url'], {})).toThrow(
      'Invalid vis_bridge target URL.',
    );
  });

  it('launches a SEA as itself even when argv uses a bare or differently-cased path', () => {
    for (const entryPath of ['vis_bridge', String.raw`C:\Program Files\VIS\VIS_BRIDGE.EXE`]) {
      expect(
        createDaemonInvocation({
          entryPath,
          execPath: String.raw`c:\program files\vis\vis_bridge.exe`,
          serverArgs: ['--port', '23120'],
          isSea: true,
        }),
      ).toEqual({
        command: String.raw`c:\program files\vis\vis_bridge.exe`,
        args: ['__daemon', '--port', '23120'],
      });
    }
  });
});
