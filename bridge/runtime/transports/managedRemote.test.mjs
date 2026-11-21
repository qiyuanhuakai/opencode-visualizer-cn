import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleRuntimeUpgrade } from '../runtimeWebSocket.js';
import { createRuntimeHost } from '../runtimeHost.js';

 test('protected credentials authenticate a retained target; wrong target and insecure credentials are rejected', async () => {
  const { createRemoteServices } = await import('../remoteServices.js');
  const target = randomUUID(), profileId = randomUUID();
  const capabilities = { methods: ['runtime.inspect'], extensions: [] };
  const grant = { target, role: 'execution', capabilities, permissions: ['runtime:read'], workspaceKeys: [] };
  const services = { target, epoch: randomUUID(), instanceId: randomUUID(), capabilities, grant,
    inspect: async (base, targets) => ({ ...base, role: 'execution', connectionProfileId: profileId, targets, harnesses: [], transports: { direct: true, ssh: false, slurm: false } }) };
  const host = createRuntimeHost({ environmentId: target, role: 'execution', services }); host.start();
  const root = await mkdtemp(path.join(tmpdir(), 'remote-credentials-'));
  const token = randomUUID();
  const credentials = path.join(root, 'remote-credentials.json');
  await writeFile(credentials, JSON.stringify({ 'keyring:remote': { bridgeToken: token } }), { mode: 0o600 });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => void handleRuntimeUpgrade(req, socket, head, { host: '127.0.0.1', bridgeToken: token, runtime: { getRuntimeHost: async () => host } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const remote = createRemoteServices({ stateRoot: root });
  try {
    const handle = await remote.openProfileTransport({ profileId, credentialRef: 'keyring:remote', enabled: true, role: 'execution', transport: { kind: 'direct', endpoint: `ws://127.0.0.1:${server.address().port}/runtime` }, target: { kind: 'direct', environmentId: target } });
    assert.equal(handle.environmentId, target);
    assert.deepEqual(remote.getTarget(target).grant, grant);
    assert.equal(remote.getTarget(target).hello.target, target);
    await handle.close();
    assert.equal(remote.getTarget(target), undefined);
    const wrongTarget = randomUUID();
    await assert.rejects(remote.openProfileTransport({ profileId: randomUUID(), credentialRef: 'keyring:remote', enabled: true, role: 'execution', transport: { kind: 'direct', endpoint: `ws://127.0.0.1:${server.address().port}/runtime` }, target: { kind: 'direct', environmentId: wrongTarget } }), error => error.code === 'conflict');
    assert.equal(remote.getTarget(wrongTarget), undefined);
    await chmod(credentials, 0o644);
    await assert.rejects(remote.openProfileTransport({ profileId, credentialRef: 'keyring:remote', enabled: true, role: 'execution', transport: { kind: 'direct', endpoint: `ws://127.0.0.1:${server.address().port}/runtime` }, target: { kind: 'direct', environmentId: target } }), error => error.code === 'unauthorized');
  } finally { await remote.close(); await host.stop(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
 });

test('managed remote reserves a pending target and cannot resurrect it after close', async () => {
  const { createRemoteServices } = await import('../remoteServices.js');
  let resolveCredential;
  const credentials = new Promise(resolve => { resolveCredential = resolve; });
  const remote = createRemoteServices({ resolveCredential: () => credentials });
  const environmentId = randomUUID();
  const profile = { profileId: randomUUID(), credentialRef: 'system', enabled: true, role: 'execution',
    transport: { kind: 'direct', endpoint: 'ws://127.0.0.1:1/runtime' }, target: { kind: 'direct', environmentId } };
  const first = remote.openProfileTransport(profile);
  await assert.rejects(remote.openProfileTransport({ ...profile, profileId: randomUUID() }), error => error.code === 'conflict');
  await remote.close();
  resolveCredential({});
  await assert.rejects(first, error => error.code === 'cancelled');
  assert.equal(remote.getTarget(environmentId), undefined);
});

test('manager re-advertises late native grants for an attached execution Bridge', async () => {
  const { createRemoteServices } = await import('../remoteServices.js');
  const { createRuntimeDispatch } = await import('../runtimeDispatch.js');
  const target = randomUUID();
  const managerTarget = randomUUID();
  const profileId = randomUUID();
  const capabilities = { methods: ['runtime.inspect', 'native.query'], extensions: [] };
  const grant = { target, role: 'execution', capabilities, permissions: ['runtime:read'], workspaceKeys: [] };
  const transports = { direct: true, ssh: false, slurm: false };
  const inspect = role => async (base, targets) => ({ ...base, role, connectionProfileId: profileId, targets, harnesses: [], transports });
  const services = { target, epoch: randomUUID(), instanceId: randomUUID(), capabilities, grant, inspect: inspect('execution') };
  const host = createRuntimeHost({ environmentId: target, role: 'execution', services });
  host.start();
  const server = createServer();
  server.on('upgrade', (req, socket, head) => void handleRuntimeUpgrade(req, socket, head, { host: '127.0.0.1', runtime: { getRuntimeHost: async () => host } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const remote = createRemoteServices({ resolveCredential: async () => ({}) });
  const managerCapabilities = { methods: ['runtime.inspect', 'runtime.target.attach'], extensions: [] };
  const managerGrant = { target: managerTarget, role: 'manager', capabilities: managerCapabilities, permissions: ['runtime:read'], workspaceKeys: [] };
  const binding = { target: managerTarget, epoch: randomUUID(), generation: 1 };
  const results = new Map();
  const dispatch = createRuntimeDispatch({
    binding, targets: [],
    management: { ...binding, instanceId: randomUUID(), grant: managerGrant, capabilities: managerCapabilities, remoteServices: remote, inspect: inspect('manager') },
    assertCurrent() {}, inspect: () => ({ role: 'manager', state: 'ready', subscribers: 1, topology: [], sources: [] }),
    send: frame => results.set(frame.id, frame), sendBinary() {}, canSend: () => true,
  });
  async function request(method, params) {
    const id = randomUUID();
    await dispatch.request({ ...binding, version: 1, kind: 'request', id, method, params });
    const frame = results.get(id);
    assert.equal(frame?.ok, true, JSON.stringify(frame?.typedError));
    return frame.result;
  }
  try {
    await remote.openProfileTransport({ profileId, credentialRef: 'system', enabled: true, role: 'execution', transport: { kind: 'direct', endpoint: `ws://127.0.0.1:${server.address().port}/runtime` }, target: { kind: 'direct', environmentId: target } });
    assert.deepEqual((await request('runtime.inspect', {})).targets.find(entry => entry.target === target).capabilities.extensions, []);
    const attached = await request('runtime.target.attach', { target });
    assert.deepEqual(attached.grant.capabilities.extensions, []);

    const extension = { owner: randomUUID(), name: 'listProviders', permission: 'codex:listProviders', schemaVersion: 1, metadata: { scope: 'instance' } };
    capabilities.extensions.push(extension);
    grant.permissions.push(extension.permission);
    const refreshed = (await request('runtime.inspect', {})).targets.find(entry => entry.target === target);
    assert.deepEqual(refreshed.capabilities.extensions, [extension]);
    assert.ok(refreshed.permissions.includes(extension.permission));

    grant.permissions.pop();
    capabilities.extensions.pop();
    const revoked = (await request('runtime.inspect', {})).targets.find(entry => entry.target === target);
    assert.deepEqual(revoked.capabilities.extensions, []);
    assert.ok(!revoked.permissions.includes(extension.permission));
  } finally {
    await dispatch.close();
    await remote.close();
    await host.stop();
    await new Promise(resolve => server.close(resolve));
  }
});
