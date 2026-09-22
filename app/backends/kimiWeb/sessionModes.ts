export const KIMI_WEB_PERMISSION_MODES = ['manual', 'auto', 'yolo'] as const;

export type KimiWebPermissionMode = (typeof KIMI_WEB_PERMISSION_MODES)[number];

export type KimiWebSessionModeChange =
  | { readonly field: 'permissionMode'; readonly value: KimiWebPermissionMode }
  | {
      readonly field: 'planMode' | 'swarmMode' | 'towerMode';
      readonly value: boolean;
    };

export type KimiWebEventSessionModePatch = {
  readonly permissionMode?: KimiWebPermissionMode;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly towerMode?: boolean;
};

export type KimiWebSessionModes = {
  readonly permissionMode: KimiWebPermissionMode;
  readonly planMode: boolean;
  readonly swarmMode: boolean;
  readonly towerMode: boolean;
};

export type KimiWebSessionModePayload =
  | { readonly agent_config: { readonly permission_mode: KimiWebPermissionMode } }
  | { readonly agent_config: { readonly plan_mode: boolean } }
  | { readonly agent_config: { readonly swarm_mode: boolean } }
  | { readonly agent_config: { readonly tower_mode: boolean } };

export function isKimiWebPermissionMode(value: unknown): value is KimiWebPermissionMode {
  return KIMI_WEB_PERMISSION_MODES.some((mode) => mode === value);
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported Kimi Web session mode field: ${String(value)}`);
}

export function serializeKimiWebSessionModeChange(
  change: KimiWebSessionModeChange,
): KimiWebSessionModePayload {
  switch (change.field) {
    case 'permissionMode':
      return { agent_config: { permission_mode: change.value } };
    case 'planMode':
      return { agent_config: { plan_mode: change.value } };
    case 'swarmMode':
      return { agent_config: { swarm_mode: change.value } };
    case 'towerMode':
      return { agent_config: { tower_mode: change.value } };
    default:
      return assertNever(change);
  }
}

export function isTowerExperimentEnabled(experimentalFlags: unknown): boolean {
  if (
    typeof experimentalFlags !== 'object' ||
    experimentalFlags === null ||
    !('experimental_flags' in experimentalFlags)
  ) {
    return false;
  }

  const flags = experimentalFlags.experimental_flags;
  return typeof flags === 'object' && flags !== null && 'tower' in flags && flags.tower === true;
}

export function applyKimiWebSessionModePatch(
  current: KimiWebSessionModes,
  patch: KimiWebEventSessionModePatch,
): KimiWebSessionModes {
  return { ...current, ...patch };
}
