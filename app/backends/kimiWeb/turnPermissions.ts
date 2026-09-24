import { ref } from 'vue';
import { StorageKeys, storageGetJSON, storageSetJSON } from '../../utils/storageKeys';
import { isKimiWebPermissionMode, type KimiWebPermissionMode } from './sessionModes';

const MAX_TURNS = 1000;
type TurnModes = Record<string, KimiWebPermissionMode>;

function validModes(value: unknown): TurnModes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key, mode]) => key.includes(':') && isKimiWebPermissionMode(mode)),
  );
}

export function createKimiWebTurnPermissionStore(
  read: () => unknown = () => storageGetJSON(StorageKeys.state.kimiWebTurnPermissions),
  write: (modes: TurnModes) => void = (modes) => { storageSetJSON(StorageKeys.state.kimiWebTurnPermissions, modes); },
) {
  const modes = ref<TurnModes>(validModes(read()));
  const keyFor = (sessionId: string, userMessageId: string) => `${sessionId}:${userMessageId}`;

  return {
    get(sessionId: string, userMessageId: string) {
      return modes.value[keyFor(sessionId, userMessageId)];
    },
    record(sessionId: string, userMessageId: string, mode: string) {
      if (!sessionId || !userMessageId || !isKimiWebPermissionMode(mode)) return;
      const entries = Object.entries({ ...modes.value, [keyFor(sessionId, userMessageId)]: mode });
      const next = Object.fromEntries(entries.slice(-MAX_TURNS)) as TurnModes;
      modes.value = next;
      write(next);
    },
  };
}
