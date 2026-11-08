// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { parseEnvironmentId, parseHarnessInstanceId } from '../../../shared/runtime/identity.js';
import { createCodexNativeOperations } from '../../../shared/runtime/native/codex/nativeOperations.js';

function fixture(pages: unknown[]) {
  let accepted: { method: string; payload: { native: unknown; credentialRef: null } };
  const request = vi.fn(async (method: string) => method === 'model/list' ? pages.shift() : { ok: true });
  const accept = vi.fn(async (value: typeof accepted) => { accepted = value; return { operationId: 'fast-config' }; });
  const native = createCodexNativeOperations({ request, validateContext() {}, privacy: (value: unknown) => value,
    instance: { accept, execute: async (_id: string, action: (value: typeof accepted) => Promise<unknown>) => ({ result: await action(accepted) }) },
  } as unknown as Parameters<typeof createCodexNativeOperations>[0]);
  const run = () => native.sendCommand({ environmentId: parseEnvironmentId('11111111-1111-4111-8111-111111111111'), harnessInstanceId: parseHarnessInstanceId('22222222-2222-4222-8222-222222222222'), params: { command: 'fast', idempotencyKey: 'fast-control', native: { modelId: 'later-model', enabled: true } } });
  return { request, accept, run };
}

it('enables Fast for a selected model on the second native catalog page', async () => {
  const { run, request } = fixture([
    { data: [{ id: 'first-model' }], nextCursor: 'second' },
    { data: [{ id: 'later-model', serviceTiers: [{ id: 'priority' }] }], nextCursor: null },
  ]);
  await run();
  expect(request.mock.calls).toEqual([
    ['model/list', { limit: 200 }], ['model/list', { limit: 200, cursor: 'second' }],
    ['config/value/write', { keyPath: 'service_tier', value: 'priority', mergeStrategy: 'replace' }],
  ]);
});

it('reports unsupported only after exhausting every model page without writing config', async () => {
  const { run, request, accept } = fixture([
    { data: [], nextCursor: 'last' }, { data: [{ id: 'different-model' }], nextCursor: null },
  ]);
  await expect(run()).rejects.toMatchObject({ code: 'unsupported', field: 'codex.fast.unavailable' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(accept).not.toHaveBeenCalled();
});

it('rejects repeated model cursors instead of changing configuration or looping', async () => {
  const { run, accept } = fixture([
    { data: [], nextCursor: 'same' }, { data: [], nextCursor: 'same' },
  ]);
  await expect(run()).rejects.toMatchObject({ code: 'reconcile_required', field: 'codex.models.cursor' });
  expect(accept).not.toHaveBeenCalled();
});
