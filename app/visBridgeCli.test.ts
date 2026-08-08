import { describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  collectStartupFailures,
  createDaemonInvocation,
} from '../bridge/daemonController.js';
import {
  fingerprintDaemonCredentials,
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
