import type { DshProjectionModelRef } from './types';

export function readDshModelRef(value: unknown): DshProjectionModelRef | undefined {
  if (typeof value !== 'object' || value === null || !('provider' in value) || !('model' in value)) return undefined;
  if (typeof value.provider !== 'string' || typeof value.model !== 'string' || !value.provider.trim() || !value.model.trim()) return undefined;
  if (value.provider === '__none__' || value.model === '__none__') return undefined;
  const reasoningEffort = 'reasoningEffort' in value && typeof value.reasoningEffort === 'string' ? value.reasoningEffort : undefined;
  return { provider: value.provider, model: value.model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}
