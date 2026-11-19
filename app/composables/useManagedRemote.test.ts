import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConnectionProfile } from '../../shared/runtime/connectionProfile.js';
import { parseEnvironmentId } from '../../shared/runtime/identity.js';
import type { HostMutationCall, HostReadCall } from '../../shared/runtime/hostWire.js';
import type { HostClient } from '../runtime/hostClient';
import { createManagedRemoteState } from './useManagedRemote';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const profile = parseConnectionProfile({ profileId: '22222222-2222-4222-8222-222222222222', name: 'Remote', transport: { kind: 'ssh', endpoint: 'cluster.example.edu' }, target: { kind: 'ssh', environmentId }, role: 'execution', credentialRef: 'system', enabled: true });
const challenge = { challengeId: 'challenge-one', kind: 'password', prompt: 'Password', echo: false, redacted: true, createdAt: 1 };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.useRealTimers(); });

function fixture() {
  let waiting = false, connected = false;
  let resolveConnect: () => void = () => {};
  let resolvePreview: (value: unknown) => void = () => {};
  const calls: HostMutationCall[] = [];
  const preview = new Promise<unknown>((resolve) => { resolvePreview = resolve; });
  const status = () => ({ profileId: profile.profileId, environmentId, generation: connected ? 1 : 0, state: connected ? 'connected' : waiting ? 'connecting' : 'disconnected' });
  async function result(call: HostReadCall): Promise<unknown> {
    if (call.domain !== 'remote') throw new Error('Unexpected host domain');
    switch (call.operation) {
      case 'capabilities': return { direct: true, ssh: true, slurm: false };
      case 'profiles': return [profile];
      case 'status': return status();
      case 'challenges': return waiting ? [challenge] : [];
      case 'identity': return null;
      case 'preview': return preview;
      default: throw new Error(`Unexpected read ${call.operation}`);
    }
  }
  const host: HostClient = {
    target: environmentId, isCurrent: () => true, onChanged: () => () => {},
    read: async <T>(call: HostReadCall, decode: (value: unknown) => T) => decode(await result(call)),
    mutate: <T>(call: HostMutationCall, decode: (value: unknown) => T, _key: string) => {
      calls.push(call);
      const executed = (async () => {
        if (call.domain !== 'remote') throw new Error('Unexpected mutation domain');
        if (call.operation === 'connect') {
          waiting = true;
          await new Promise<void>((resolve) => { resolveConnect = resolve; });
          waiting = false; connected = true;
          return decode(status());
        }
        if (call.operation === 'respond') { resolveConnect(); return decode({ answered: true }); }
        throw new Error(`Unexpected mutation ${call.operation}`);
      })();
      return { accepted: Promise.resolve({ operationId: 'operation' }), executed };
    },
  };
  const onConnected = vi.fn(async (_environment: typeof environmentId) => {});
  const state = createManagedRemoteState({ getHost: () => host, onConnected });
  cleanups.push(state.close);
  return { state, calls, onConnected, resolvePreview };
}

describe('production remote UI controller', () => {
  it('reads authentication challenges while connect is pending and sends the exact captured answer', async () => {
    vi.useFakeTimers();
    const { state, calls, onConnected } = fixture();
    await state.open();
    const connecting = state.connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.busy.value).toBe(true);
    expect(state.challenge.value?.challengeId).toBe(challenge.challengeId);
    await state.respond({ challengeId: challenge.challengeId, accept: true, secret: 'fixture-password' });
    await connecting;
    expect(calls.filter((call) => call.operation === 'respond')).toEqual([{ domain: 'remote', operation: 'respond', args: { profileId: profile.profileId, challengeId: challenge.challengeId, answer: { accept: true, secret: 'fixture-password' } } }]);
    expect(state.status.value?.state).toBe('connected');
    expect(onConnected).toHaveBeenCalledWith(environmentId);
    expect(state.busy.value).toBe(false);
    expect(state.challenge.value).toBeNull();
  });

  it('refuses an obsolete challenge and ignores a preview completed after the manager surface closes', async () => {
    vi.useFakeTimers();
    const { state, calls, resolvePreview } = fixture();
    await state.open();
    await state.respond({ challengeId: 'obsolete', accept: true, secret: 'obsolete-secret' });
    expect(calls).toEqual([]);
    const pending = state.previewSlurm({ partition: 'debug', cpus: 1, memory: '1G', time: '00:10:00', gres: 'none' });
    state.close();
    resolvePreview({ nodes: 1, ntasks: 1, cpus: 1, memory: '1G', memoryMiB: 1024, time: '00:10:00', timeSeconds: 600, gres: 'none', requestsGpu: false, partition: 'debug', account: null });
    await pending;
    expect(state.preview.value).toBeNull();
    expect(state.busy.value).toBe(false);
    expect(state.error.value).toBe('');
  });
});
