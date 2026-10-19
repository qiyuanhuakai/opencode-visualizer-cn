import type { ConnectionProfileId, HarnessInstanceId } from '../../shared/runtime/identity.js';
export function loadRuntimeRegistrations(stateRoot: string, keys: readonly string[]): Promise<{ readonly connectionProfileId: ConnectionProfileId; readonly harnesses: ReadonlyMap<string, HarnessInstanceId> }>;

