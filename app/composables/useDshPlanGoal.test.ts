import { effectScope, nextTick, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { useDshPlanGoal } from './useDshPlanGoal';
import type { DshJsonValue } from '../backends/dsh/types';

async function flushPromises() { for (let index = 0; index < 8; index++) await nextTick(); }

const initialGoal = { id: 'goal-1', revision: 2, objective: 'Original', phase: 'paused', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 8 };
function setup() {
  let goal: DshJsonValue = initialGoal;
  let active = false;
  const call = vi.fn(async (namespace: string, method: string, args?: Record<string, DshJsonValue>): Promise<DshJsonValue> => {
    if (namespace === 'session') return { values: { plan: { active, pending: false } } };
    if (namespace === 'commands') { active = args?.line === '/plan'; return { result: { kind: 'success' } }; }
    if (method === 'get') return goal;
    if (method === 'clear') goal = null;
    if (method === 'edit') goal = { ...initialGoal, objective: 'Changed', revision: 3 };
    return {};
  });
  const client = { call };
  const sessionId = ref('first'); const revision = ref(0);
  const scope = effectScope();
  const control = scope.run(() => useDshPlanGoal(() => ({ client, sessionId: sessionId.value, revision: revision.value })));
  if (!control) throw new Error('No control');
  return { control, call, scope, sessionId, revision };
}

it('toggles plan using the native command and confirms the persisted projection', async () => {
  const h = setup(); await flushPromises();
  await h.control.togglePlan();
  expect(h.control.plan.value).toEqual({ active: true, pending: false });
  expect(h.call).toHaveBeenCalledWith('commands', 'execute', { agentId: 'first', line: '/plan', submittedAttachments: [] });
  await h.control.togglePlan();
  expect(h.control.plan.value?.active).toBe(false);
  h.scope.stop();
});

it('edits with the exact current goal revision then reads server confirmation', async () => {
  const h = setup(); await flushPromises();
  await h.control.changeGoal('save', 'Changed');
  expect(h.call).toHaveBeenCalledWith('goals', 'edit', { agentId: 'first', ref: { id: 'goal-1', revision: 2 }, request: { objective: 'Changed' } });
  expect(h.control.goal.value?.objective).toBe('Changed');
  h.scope.stop();
});

it('clears through the native CAS endpoint and shows the empty server state', async () => {
  const h = setup(); await flushPromises();
  await h.control.changeGoal('clear');
  expect(h.control.goal.value).toBeNull();
  expect(h.call).toHaveBeenCalledWith('goals', 'clear', { agentId: 'first', ref: { id: 'goal-1', revision: 2 } });
  h.scope.stop();
});

it('keeps confirmed goal and plan visible when a write fails', async () => {
  const h = setup(); await flushPromises();
  h.call.mockRejectedValueOnce(new Error('CAS conflict'));
  expect(await h.control.changeGoal('clear')).toBe(false);
  expect(h.control.goal.value?.objective).toBe('Original');
  expect(h.control.error.value).toBe('CAS conflict');
  expect(h.control.loaded.value).toBe(false);
  await h.control.refresh();
  expect(h.control.loaded.value).toBe(true);
  h.scope.stop();
});

it('refreshes after slash events without clearing the confirmed state', async () => {
  const h = setup(); await flushPromises();
  const previous = h.control.goal.value;
  h.revision.value++;
  await nextTick();
  expect(h.control.goal.value).toBe(previous);
  await flushPromises();
  expect(h.call.mock.calls.filter(([, method]) => method === 'get')).toHaveLength(2);
  h.scope.stop();
});

it('ignores an old read after switching sessions', async () => {
  const h = setup(); await flushPromises();
  let resolve: (value: DshJsonValue) => void = () => {};
  h.call.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const stale = h.control.refresh();
  h.sessionId.value = 'second'; await nextTick(); await flushPromises();
  resolve({ ...initialGoal, objective: 'Stale' }); await stale;
  expect(h.control.sessionId.value).toBe('second');
  expect(h.control.goal.value?.objective).toBe('Original');
  h.scope.stop();
});

it('does not publish an old mutation result into a newly selected session', async () => {
  const h = setup(); await flushPromises();
  let resolve: (value: DshJsonValue) => void = () => {};
  h.call.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const stale = h.control.changeGoal('clear');
  h.sessionId.value = 'second'; await nextTick(); await flushPromises();
  resolve({ id: 'goal-1', revision: 3 });
  expect(await stale).toBe(false);
  expect(h.control.goal.value?.objective).toBe('Original');
  expect(h.control.error.value).toBe('');
  h.scope.stop();
});
