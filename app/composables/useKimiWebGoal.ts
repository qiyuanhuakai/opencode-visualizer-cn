import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { KimiWebGoal, KimiWebGoalChange } from '../backends/kimiWeb/goal';
import type { KimiWebClient } from '../utils/kimiWeb';

export type KimiWebGoalClient = Pick<KimiWebClient, 'getGoal' | 'updateProfile'>;

export function useKimiWebGoal(target: () => { sessionId: string; client: KimiWebGoalClient; revision?: number } | null) {
  const goal = shallowRef<KimiWebGoal | null>(null);
  const objective = ref('');
  const pending = ref(false);
  const loaded = ref(false);
  const error = ref('');
  let generation = 0;

  async function refresh(change?: KimiWebGoalChange) {
    const selected = target();
    if (pending.value || !selected?.sessionId.trim()) return false;
    const requestGeneration = ++generation;
    const { client, sessionId } = selected;
    let mutated = false;
    pending.value = true;
    error.value = '';
    try {
      if (change) {
        await client.updateProfile(sessionId, { agent_config: change });
        mutated = true;
      }
      if (requestGeneration !== generation) return false;
      const result = await client.getGoal(sessionId);
      if (requestGeneration !== generation) return false;
      goal.value = result;
      objective.value = result?.objective ?? '';
      loaded.value = true;
      return true;
    } catch (cause) {
      if (requestGeneration !== generation) return false;
      error.value = cause instanceof Error ? cause.message : String(cause);
      loaded.value = false;
      return mutated;
    } finally {
      if (requestGeneration === generation) pending.value = false;
    }
  }

  watch(
    target,
    () => {
      generation++;
      goal.value = null;
      objective.value = '';
      loaded.value = false;
      pending.value = false;
      error.value = '';
      void refresh();
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    generation++;
  });
  return { goal, objective, pending, loaded, error, refresh };
}
