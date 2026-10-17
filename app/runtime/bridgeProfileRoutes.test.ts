import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { handleProfileHttpRequest } from '../../bridge/bridgeHttpRoutes.js';
import { createBridgeConfigStore, defaultBridgeProfilePath } from '../../bridge/bridgeConfig.js';
import { createConnectionManager } from '../../bridge/runtime/transports/connectionManager.js';
import { createProfileStore } from '../../bridge/runtime/transports/profileStore.js';
import { resolveProfileEnvironment } from '../../shared/runtime/connectionProfile.js';
import { parseEnvironmentId } from '../../shared/runtime/identity.js';

const environment = parseEnvironmentId('11111111-1111-4111-8111-111111111111');

function responseCapture() {
  const state: { status: number; headers: Record<string, string>; body: unknown } = {
    status: 0,
    headers: {},
    body: undefined,
  };
  return {
    state,
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status;
      state.headers = headers ?? {};
    },
    end(body?: string) {
      state.body = typeof body === 'string' ? JSON.parse(body) : body;
    },
  };
}

function requestEmitting(method: string, body?: unknown) {
  const request = new EventEmitter() as EventEmitter & { method: string; pause: () => void };
  request.method = method;
  request.pause = () => {};
  queueMicrotask(() => {
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)));
    request.emit('end');
  });
  return request;
}

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'vis-profile-routes-'));
  const store = createProfileStore({ profilePath: path.join(directory, 'profiles.json') });
  const manager = createConnectionManager({
    store,
    openTransport: async (profile) => ({
      environmentId: resolveProfileEnvironment(profile),
      connectionId: 'c-1',
      close: vi.fn(),
    }),
  });
  return { directory, store, manager };
}

async function call(
  manager: unknown,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ handled: boolean; status: number; headers: Record<string, string>; body: any }> {
  const response = responseCapture();
  const handled = await handleProfileHttpRequest(
    requestEmitting(method, body) as never,
    response as never,
    new URL(url, 'http://localhost'),
    manager as never,
  );
  return { handled, status: response.state.status, headers: response.state.headers, body: response.state.body };
}

const input = {
  name: 'Workstation',
  transport: { kind: 'local' },
  target: { kind: 'local', environmentId: environment },
  role: 'local',
  credentialRef: 'cred-1',
};

describe('profile management HTTP API (Browser and Electron share one surface)', () => {
  it('creates, lists, edits, enables, connects, reconnects and deletes one profile', async () => {
    const { directory, manager } = await setup();
    try {
      const created = await call(manager, 'POST', '/api/v1/profiles', input);
      expect(created.status).toBe(201);
      expect(created.handled).toBe(true);
      expect(created.headers['Access-Control-Allow-Origin']).toBe('*');
      const profileId: string = created.body.profileId;
      expect(profileId).toBeTruthy();
      expect(created.body.enabled).toBe(false);
      expect(JSON.stringify(created.body)).not.toContain('super-secret');

      const listed = await call(manager, 'GET', '/api/v1/profiles');
      expect(listed.status).toBe(200);
      expect(listed.body.profiles).toHaveLength(1);

      const refused = await call(manager, 'POST', `/api/v1/profiles/${profileId}/connect`);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.body.code).toBe('source_unavailable');

      const enabled = await call(manager, 'PUT', `/api/v1/profiles/${profileId}/enabled`, {
        enabled: true,
      });
      expect(enabled.status).toBe(200);
      expect(enabled.body.enabled).toBe(true);

      const connected = await call(manager, 'POST', `/api/v1/profiles/${profileId}/connect`);
      expect(connected.status).toBe(200);
      expect(connected.body.state).toBe('connected');
      expect(connected.body.environmentId).toBe(environment);

      const edited = await call(manager, 'PATCH', `/api/v1/profiles/${profileId}`, {
        name: 'Renamed',
      });
      expect(edited.status).toBe(200);
      expect(edited.body.profileId).toBe(profileId);
      expect(edited.body.target.environmentId).toBe(environment);

      const reconnected = await call(manager, 'POST', `/api/v1/profiles/${profileId}/reconnect`);
      expect(reconnected.status).toBe(200);
      expect(reconnected.body.environmentId).toBe(environment);

      const disconnected = await call(manager, 'POST', `/api/v1/profiles/${profileId}/disconnect`);
      expect(disconnected.status).toBe(200);
      expect(disconnected.body.state).toBe('disconnected');

      const deleted = await call(manager, 'DELETE', `/api/v1/profiles/${profileId}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body.nativeHistoryPreserved).toBe(true);
      expect(deleted.body.ownedJobsPreserved).toBe(true);
      expect(deleted.body.cancelledJobs).toBe(0);

      const empty = await call(manager, 'GET', '/api/v1/profiles');
      expect(empty.body.profiles).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a secret-bearing payload with 400 and never echoes the secret', async () => {
    const { directory, manager } = await setup();
    try {
      const withSecret = await call(manager, 'POST', '/api/v1/profiles', {
        ...input,
        password: 'super-secret',
      });
      expect(withSecret.status).toBe(400);
      expect(withSecret.body.code).toBe('invalid_request');
      expect(JSON.stringify(withSecret.body)).not.toContain('super-secret');

      const badEndpoint = await call(manager, 'POST', '/api/v1/profiles', {
        ...input,
        transport: { kind: 'direct', endpoint: 'wss://bridge.test/runtime?token=super-secret' },
        target: { kind: 'direct', environmentId: environment },
      });
      expect(badEndpoint.status).toBe(400);
      expect(JSON.stringify(badEndpoint.body)).not.toContain('super-secret');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns 404 for an unknown profile and does not handle unrelated paths', async () => {
    const { directory, manager } = await setup();
    try {
      const unknown = await call(manager, 'GET', '/api/v1/profiles/00000000-0000-4000-8000-000000000000');
      expect(unknown.status).toBe(404);
      expect(unknown.handled).toBe(true);

      const unrelated = await call(manager, 'GET', '/api/v1/supervisor');
      expect(unrelated.handled).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('binds profile state to the bridge config location shared by both clients', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-profile-config-'));
    try {
      const configPath = path.join(directory, 'bridge.json');
      expect(createBridgeConfigStore({ configPath }).profilePath).toBe(
        path.join(directory, 'profiles.json'),
      );
      expect(defaultBridgeProfilePath({ XDG_CONFIG_HOME: directory })).toBe(
        path.join(directory, 'vis', 'profiles.json'),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
