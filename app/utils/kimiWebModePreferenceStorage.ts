import {
  isKimiWebPermissionMode,
  type KimiWebEventSessionModePatch,
  type KimiWebSessionModeChange,
} from '../backends/kimiWeb/sessionModes';
import { storageGetJSON, storageSetJSON } from './storageKeys';

function parsePreferences(value: unknown): KimiWebEventSessionModePatch | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const permissionMode = 'permissionMode' in value ? value.permissionMode : undefined;
  const planMode = 'planMode' in value ? value.planMode : undefined;
  const swarmMode = 'swarmMode' in value ? value.swarmMode : undefined;
  const towerMode = 'towerMode' in value ? value.towerMode : undefined;
  const modes: KimiWebEventSessionModePatch = {
    ...(isKimiWebPermissionMode(permissionMode) ? { permissionMode } : {}),
    ...(typeof planMode === 'boolean' ? { planMode } : {}),
    ...(typeof swarmMode === 'boolean' ? { swarmMode } : {}),
    ...(typeof towerMode === 'boolean' ? { towerMode } : {}),
  };
  return Object.keys(modes).length ? modes : undefined;
}

export function createKimiWebModePreferenceStore(getScope: () => string, getLegacyScope?: () => string | undefined) {
  function keyFor(sessionId: string, scope = getScope()): string {
    return `kimiWebSessionModes.${encodeURIComponent(JSON.stringify([scope, sessionId]))}`;
  }

  return {
    read(sessionId: string): KimiWebEventSessionModePatch | undefined {
      const scope = getLegacyScope?.();
      const previous = scope ? parsePreferences(storageGetJSON<unknown>(keyFor(sessionId, scope))) : undefined;
      const current = parsePreferences(storageGetJSON<unknown>(keyFor(sessionId)));
      return current && previous ? { ...previous, ...current } : current ?? previous;
    },
    write(sessionId: string, change: KimiWebSessionModeChange): void {
      const key = keyFor(sessionId);
      const current = parsePreferences(storageGetJSON<unknown>(key));
      storageSetJSON(key, { ...current, [change.field]: change.value });
    },
  };
}
