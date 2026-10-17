import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame, decodeFrame, type Hello, type Request } from '../../shared/runtime/protocol.js';
import { encodeSessionKey, parseConnectionProfileId, parseEnvironmentId, parseHarnessInstanceId, parseInstanceId } from '../../shared/runtime/identity.js';
import type { RuntimeInspection } from '../../shared/runtime/runtimeWire.js';
import { adoptConnectionReference, connectionError, managementCandidate, normalizeManagementUrl, parseConnectionReference, RuntimeConnectionError } from './connectionProfile';
import { managementCandidate as directCandidate, RuntimeConnectionError as DirectConnectionError } from './connectionUrl';
import { useRuntimeConnection } from '../composables/useRuntimeConnection';
import type { RuntimeSocket } from './connection';

const environment = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const profile = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const selectedSession = { environmentId: environment, harnessInstanceId: parseHarnessInstanceId('77777777-7777-4777-8777-777777777777'), nativeSessionId: 'selected-native' };
const selectedQuery = { profileId: profile, sessionKey: encodeSessionKey(selectedSession) };
const hello: Hello = { version: 1, kind: 'hello', target: environment, epoch: 'epoch-a', generation: 1, instanceId: parseInstanceId('22222222-2222-4222-8222-222222222222'), capabilities: { methods: ['runtime.inspect'], extensions: [] } };
const inspection: RuntimeInspection = { role: 'local', state: 'ready', subscribers: 1, topology: [], sources: [], connectionProfileId: profile, targets: [{ target: environment, role: 'local', capabilities: hello.capabilities, permissions: [], workspaceKeys: [] }], harnesses: [], transports: { direct: true, ssh: false, slurm: false } };
class InspectSocket extends EventTarget implements RuntimeSocket {
  binaryType: BinaryType = 'blob'; readyState: WebSocket['readyState'] = 1; bufferedAmount = 0;
  requests: Request[] = [];
  close = vi.fn(() => { this.readyState = 3; });
  send(data: string | Uint8Array) {
    if (typeof data !== 'string') throw new Error('unexpected binary');
    const frame = decodeFrame(data); if (frame.kind !== 'request') throw new Error('unexpected frame');
    this.requests.push(frame);
  }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(value) })); }
  reply(result: RuntimeInspection = inspection) {
    const request = this.requests.at(-1); if (!request) throw new Error('inspect request missing');
    this.message({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: true, phase: 'read', result });
  }
}
const owned: Array<ReturnType<typeof useRuntimeConnection>> = [];
afterEach(() => { for (const value of owned.splice(0)) value.dispose(); });
function bootstrap() {
  const sockets: InspectSocket[] = [];
  const value = useRuntimeConnection({ reference: managementCandidate('ws://selected.test/codex'), selection: selectedQuery, resolveAuthentication: async () => ({ bridgeToken: 'hidden-management' }), createWebSocket: () => { const socket = new InspectSocket(); sockets.push(socket); return socket; } });
  owned.push(value);
  async function receiveHello() {
    await vi.waitFor(() => expect(sockets.at(-1)).toBeDefined());
    const socket = sockets.at(-1); if (!socket) throw new Error('socket missing');
    socket.message(hello); await vi.waitFor(() => expect(socket.requests).toHaveLength(1)); return socket;
  }
  return { value, sockets, receiveHello };
}

describe('Runtime selected profile bootstrap', () => {
  it('retains typed URL errors across the direct credential and profile imports', () => {
    let failure: unknown;
    try { directCandidate('ws://bridge.test/runtime?token=private'); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(DirectConnectionError);
    expect(failure).toBeInstanceOf(RuntimeConnectionError);
    expect(connectionError(failure)).toMatchObject({ code: 'invalid_request', message: 'Runtime connection: invalid_request' });
  });
  it.each(['/codex', '/', '/acp', '/kimi-web/ws', '/dsh/ws'])('maps the explicitly selected legacy %s endpoint without fabricating a profile', suffix => {
    expect(managementCandidate(`wss://selected.test${suffix}`)).toEqual({ url: 'wss://selected.test/runtime' });
  });
  it.each(['http://native.test', 'ws://user:private@bridge.test/runtime', 'ws://bridge.test/runtime?token=private', 'ws://bridge.test/runtime#private', 'ws://bridge.test/native', 'private'])('rejects unsafe public endpoint %s', url => {
    expect(() => normalizeManagementUrl(url)).toThrow();
  });
  it('rejects hidden fields and checks expected environment and existing profile during adoption', () => {
    expect(() => parseConnectionReference({ url: 'ws://selected.test/runtime', bridgeToken: 'private' })).toThrow();
    expect(() => adoptConnectionReference({ url: 'ws://selected.test/runtime', expectedEnvironmentId: parseEnvironmentId('44444444-4444-4444-8444-444444444444') }, hello, inspection)).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => adoptConnectionReference({ url: 'ws://selected.test/runtime', profileId: parseConnectionProfileId('55555555-5555-4555-8555-555555555555') }, hello, inspection)).toThrow(expect.objectContaining({ code: 'conflict' }));
  });
  it('adopts only after actual socket Hello and correlated authenticated inspection', async () => {
    const fixture = bootstrap(); const connected = fixture.value.connect(); const socket = await fixture.receiveHello();
    expect(fixture.value.reference.value).toBeNull();
    socket.reply(); await expect(connected).resolves.toEqual({ profileId: profile, url: 'ws://selected.test/runtime', expectedEnvironmentId: environment });
    expect(fixture.value.reference.value?.profileId).toBe(profile);
    expect(JSON.stringify([fixture.value.reference.value, fixture.value.status.value])).not.toContain('hidden-management');
  });
  it('does not adopt after an unauthorized inspection result', async () => {
    const fixture = bootstrap(); const connected = fixture.value.connect(); const rejected = expect(connected).rejects.toMatchObject({ code: 'unauthorized' });
    const socket = await fixture.receiveHello(); const request = socket.requests[0];
    socket.message({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: false, typedError: { code: 'unauthorized', message: 'private-detail' } });
    await rejected; expect(fixture.value.reference.value).toBeNull(); expect(fixture.value.status.value.error?.message).not.toContain('private-detail');
  });
  it('keeps a late old inspection from adopting over a replacement socket', async () => {
    const fixture = bootstrap(); const first = fixture.value.connect(); const rejected = expect(first).rejects.toBeDefined();
    const old = await fixture.receiveHello(); fixture.value.disconnect(); await rejected;
    const next = fixture.value.connect(); await vi.waitFor(() => expect(fixture.sockets).toHaveLength(2));
    const current = await fixture.receiveHello(); old.reply(); expect(fixture.value.reference.value).toBeNull();
    current.reply(); await next; expect(fixture.value.reference.value?.profileId).toBe(profile); expect(old.close).toHaveBeenCalledOnce();
  });
  it.each(['profile', 'environment'])('pins the first proven candidate %s across reconnect', async identity => {
    const fixture = bootstrap(); const first = fixture.value.connect(); const old = await fixture.receiveHello(); old.reply(); await first;
    expect(fixture.value.resolveSelection([selectedSession], true)?.kind).toBe('resolved');
    fixture.value.disconnect(); const next = fixture.value.connect();
    const rejected = expect(next).rejects.toMatchObject({ code: 'conflict' });
    await vi.waitFor(() => expect(fixture.sockets).toHaveLength(2));
    const current = fixture.sockets[1];
    const target = identity === 'environment' ? parseEnvironmentId('44444444-4444-4444-8444-444444444444') : environment;
    current.message({ ...hello, target, generation: 2 });
    await vi.waitFor(() => expect(current.requests).toHaveLength(1));
    current.reply({ ...inspection, connectionProfileId: identity === 'profile' ? parseConnectionProfileId('55555555-5555-4555-8555-555555555555') : profile });
    await rejected; expect(fixture.value.reference.value).toBeNull(); expect(fixture.value.status.value.error?.code).toBe('conflict');
    expect(fixture.value.selection.value).toEqual({ kind: 'pending', requested: selectedQuery });
  });
  it('allows a new server generation for the same proven candidate identity', async () => {
    const fixture = bootstrap(); const first = fixture.value.connect(); const old = await fixture.receiveHello(); old.reply(); await first;
    fixture.value.disconnect(); const next = fixture.value.connect(); await vi.waitFor(() => expect(fixture.sockets).toHaveLength(2));
    const current = fixture.sockets[1]; current.message({ ...hello, generation: 9, epoch: 'replacement-epoch' });
    await vi.waitFor(() => expect(current.requests).toHaveLength(1)); current.reply();
    await expect(next).resolves.toEqual({ profileId: profile, url: 'ws://selected.test/runtime', expectedEnvironmentId: environment });
  });
});
