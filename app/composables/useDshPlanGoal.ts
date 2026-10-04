import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { DshRpcClient } from '../utils/dshRpc';

export type DshGoal = {
  readonly id: string; readonly revision: number; readonly objective: string;
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete';
  readonly activation: 'armed' | 'disarmed'; readonly roundsStarted: number; readonly maxGoalRounds: number;
};
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function readGoal(value: unknown): DshGoal | null {
  if (value == null) return null;
  if (!record(value) || typeof value.id !== 'string' || typeof value.revision !== 'number' || typeof value.objective !== 'string'
    || (value.phase !== 'active' && value.phase !== 'paused' && value.phase !== 'blocked' && value.phase !== 'complete')
    || (value.activation !== 'armed' && value.activation !== 'disarmed') || typeof value.roundsStarted !== 'number' || typeof value.maxGoalRounds !== 'number') throw new Error('Invalid DSH goal');
  return { id: value.id, revision: value.revision, objective: value.objective, phase: value.phase, activation: value.activation, roundsStarted: value.roundsStarted, maxGoalRounds: value.maxGoalRounds };
}
function readPlan(value: unknown) {
  if (!record(value) || !record(value.values)) throw new Error('Invalid DSH projections');
  if (value.values.plan === undefined) return null;
  const plan = value.values.plan;
  if (!record(plan) || typeof plan.active !== 'boolean' || typeof plan.pending !== 'boolean') throw new Error('Invalid DSH plan');
  return { active: plan.active, pending: plan.pending };
}
export type DshPlanGoalTarget = { readonly sessionId: string; readonly client: Pick<DshRpcClient, 'call'>; readonly revision?: number };

export function useDshPlanGoal(target: () => DshPlanGoalTarget | null) {
  const goal = shallowRef<DshGoal | null>(null);
  const plan = shallowRef<{ active: boolean; pending: boolean } | null>(null);
  const pending = ref(false);
  const loaded = ref(false);
  const error = ref('');
  const sessionId = computed(() => target()?.sessionId ?? '');
  let generation = 0;
  let queuedRefresh = false;

  async function refresh(operation?: (selected: DshPlanGoalTarget) => Promise<unknown>) {
    const selected = target();
    if (!selected || !selected.sessionId || pending.value) return false;
    const current = generation;
    pending.value = true;
    error.value = '';
    try {
      if (operation) await operation(selected);
      if (current !== generation) return false;
      const [goalValue, projections] = await Promise.all([
        selected.client.call('goals', 'get', { agentId: selected.sessionId }),
        selected.client.call('session', 'projections', { request: { sessionId: selected.sessionId } }),
      ]);
      if (current !== generation) return false;
      const nextGoal = readGoal(goalValue);
      const nextPlan = readPlan(projections);
      goal.value = nextGoal;
      plan.value = nextPlan;
      loaded.value = true;
      return true;
    } catch (cause) {
      if (current === generation) {
        error.value = cause instanceof Error ? cause.message : String(cause);
        loaded.value = false;
      }
      return false;
    } finally {
      if (current === generation) {
        pending.value = false;
        if (queuedRefresh) { queuedRefresh = false; void refresh(); }
      }
    }
  }

  async function togglePlan() {
    if (!loaded.value || !plan.value) return false;
    const enabled = plan.value.pending ? !plan.value.active : plan.value.active;
    return refresh(async ({ client, sessionId: agentId }) => {
      const value = await client.call('commands', 'execute', { agentId, line: enabled ? '/plan off' : '/plan', submittedAttachments: [] });
      if (!record(value) || !record(value.result) || value.result.kind !== 'success') throw new Error(record(value) && record(value.result) && typeof value.result.text === 'string' ? value.result.text : 'DSH plan command failed');
    });
  }

  async function changeGoal(action: 'save' | 'clear' | 'pause' | 'resume', objective = '') {
    if (!loaded.value || (action === 'save' && !objective.trim())) return false;
    const previous = goal.value;
    if (action !== 'save' && !previous) return false;
    const method = action === 'save' ? (!previous || previous.phase === 'complete' ? 'create' : 'edit') : action;
    return refresh(({ client, sessionId: agentId }) => client.call('goals', method, {
      agentId,
      ...(method !== 'create' && previous ? { ref: { id: previous.id, revision: previous.revision } } : {}),
      ...(action === 'save' ? { request: { objective: objective.trim() } } : {}),
    }));
  }

  watch([() => target()?.client, () => target()?.sessionId], () => {
    generation++;
    pending.value = false;
    queuedRefresh = false;
    loaded.value = false;
    goal.value = null;
    plan.value = null;
    error.value = '';
    void refresh();
  }, { immediate: true });
  watch(() => target()?.revision, () => {
    if (pending.value) queuedRefresh = true;
    else void refresh();
  });
  onScopeDispose(() => { generation++; });
  return { sessionId, goal, plan, pending, loaded, error, refresh, togglePlan, changeGoal };
}
export type DshPlanGoalControl = ReturnType<typeof useDshPlanGoal>;
