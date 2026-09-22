import { KimiWebTowerExperimentUnavailableError } from '../backends/kimiWeb/kimiWebAdapter';
import {
  isKimiWebPermissionMode,
  isTowerExperimentEnabled,
  type KimiWebPermissionMode,
  type KimiWebSessionModeChange,
} from '../backends/kimiWeb/sessionModes';
import { KimiWebError } from '../utils/kimiWeb';
import type { KimiWebFrameContext, KimiWebSessionModePatch } from './kimiWebMessageBridgeTypes';

export type KimiWebModeConfidence = 'unknown' | 'accepted-locally' | 'confirmed' | 'stale';

export type KimiWebSessionModeState = {
  readonly permissionMode?: KimiWebPermissionMode;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly towerMode?: boolean;
  readonly confidence: KimiWebModeConfidence;
  readonly pendingField?: KimiWebSessionModeChange['field'];
  readonly error?:
    | { readonly kind: 'rejected'; readonly message: string }
    | { readonly kind: 'uncertain' };
};

export type KimiWebSessionModesOptions = {
  readonly writeMode: (sessionId: string, change: KimiWebSessionModeChange) => Promise<void>;
  readonly loadMeta: () => Promise<unknown>;
};

type ModeField = KimiWebSessionModeChange['field'];

type MutableSessionState = {
  permissionMode?: KimiWebPermissionMode;
  planMode?: boolean;
  swarmMode?: boolean;
  towerMode?: boolean;
  confidence: KimiWebModeConfidence;
  pendingField?: ModeField;
  error?: KimiWebSessionModeState['error'];
  frame?: KimiWebFrameContext;
  supersededEpochs: Set<string>;
  fieldVersions: Record<ModeField, number>;
};

function emptyFieldVersions(): Record<ModeField, number> {
  return { permissionMode: 0, planMode: 0, swarmMode: 0, towerMode: 0 };
}

function isBusinessRejection(error: unknown): boolean {
  return (
    error instanceof KimiWebError || error instanceof KimiWebTowerExperimentUnavailableError
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicState(state?: MutableSessionState): KimiWebSessionModeState {
  if (!state) return { confidence: 'unknown' };
  const result: KimiWebSessionModeState = {
    confidence: state.confidence,
    ...(state.permissionMode === undefined ? {} : { permissionMode: state.permissionMode }),
    ...(state.planMode === undefined ? {} : { planMode: state.planMode }),
    ...(state.swarmMode === undefined ? {} : { swarmMode: state.swarmMode }),
    ...(state.towerMode === undefined ? {} : { towerMode: state.towerMode }),
    ...(state.pendingField === undefined ? {} : { pendingField: state.pendingField }),
    ...(state.error === undefined ? {} : { error: state.error }),
  };
  return result;
}

function hasModePatch(patch: KimiWebSessionModePatch): boolean {
  return (
    isKimiWebPermissionMode(patch.permission) ||
    patch.planMode !== undefined ||
    patch.swarmMode !== undefined ||
    patch.towerMode !== undefined
  );
}

function modeValue(state: MutableSessionState, field: ModeField) {
  switch (field) {
    case 'permissionMode':
      return state.permissionMode;
    case 'planMode':
      return state.planMode;
    case 'swarmMode':
      return state.swarmMode;
    case 'towerMode':
      return state.towerMode;
  }
}

function setModeValue(state: MutableSessionState, change: KimiWebSessionModeChange) {
  switch (change.field) {
    case 'permissionMode':
      state.permissionMode = change.value;
      break;
    case 'planMode':
      state.planMode = change.value;
      break;
    case 'swarmMode':
      state.swarmMode = change.value;
      break;
    case 'towerMode':
      state.towerMode = change.value;
      break;
  }
}

function restoreModeValue(
  state: MutableSessionState,
  field: ModeField,
  value: KimiWebPermissionMode | boolean | undefined,
) {
  if (field === 'permissionMode') {
    if (value === undefined) delete state.permissionMode;
    else if (typeof value === 'string') state.permissionMode = value;
    return;
  }
  if (field === 'planMode') {
    if (value === undefined) delete state.planMode;
    else if (typeof value === 'boolean') state.planMode = value;
    return;
  }
  if (field === 'swarmMode') {
    if (value === undefined) delete state.swarmMode;
    else if (typeof value === 'boolean') state.swarmMode = value;
    return;
  }
  if (value === undefined) delete state.towerMode;
  else if (typeof value === 'boolean') state.towerMode = value;
}

export function useKimiWebSessionModes(options: KimiWebSessionModesOptions) {
  const sessions = new Map<string, MutableSessionState>();
  const inFlight = new Set<string>();
  const generations = new Map<string, number>();
  let disposed = false;
  let towerMetaLoaded = false;
  let towerEnabled = false;

  function stateFor(sessionId: string): MutableSessionState {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        confidence: 'unknown',
        supersededEpochs: new Set(),
        fieldVersions: emptyFieldVersions(),
      };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function bumpGeneration(sessionId: string): number {
    const generation = (generations.get(sessionId) ?? 0) + 1;
    generations.set(sessionId, generation);
    return generation;
  }

  function isCurrent(sessionId: string, generation: number): boolean {
    return !disposed && generations.get(sessionId) === generation;
  }

  async function allowTowerEnable(): Promise<boolean> {
    if (!towerMetaLoaded) {
      towerMetaLoaded = true;
      try {
        towerEnabled = isTowerExperimentEnabled(await options.loadMeta());
      } catch {
        towerEnabled = false;
      }
    }
    return towerEnabled;
  }

  function isOlderFrame(state: MutableSessionState, context: KimiWebFrameContext): boolean {
    if (context.epoch && state.supersededEpochs.has(context.epoch)) return true;
    const previous = state.frame;
    if (!previous || previous.epoch !== context.epoch) return false;
    if (previous.sequence !== undefined && context.sequence !== undefined) {
      return context.sequence <= previous.sequence;
    }
    return previous.origin === 'live' && context.origin === 'durable-replay';
  }

  function applyPatch(state: MutableSessionState, patch: KimiWebSessionModePatch) {
    if (isKimiWebPermissionMode(patch.permission)) {
      state.permissionMode = patch.permission;
      state.fieldVersions.permissionMode += 1;
    }
    if (patch.planMode !== undefined) {
      state.planMode = patch.planMode;
      state.fieldVersions.planMode += 1;
    }
    if (patch.swarmMode !== undefined) {
      state.swarmMode = patch.swarmMode;
      state.fieldVersions.swarmMode += 1;
    }
    if (patch.towerMode !== undefined) {
      state.towerMode = patch.towerMode;
      state.fieldVersions.towerMode += 1;
    }
  }

  return {
    sessionState(sessionId: string): KimiWebSessionModeState {
      return publicState(sessions.get(sessionId));
    },
    get towerEnabled() {
      return towerEnabled;
    },
    async changeMode(sessionId: string, change: KimiWebSessionModeChange): Promise<void> {
      if (disposed) throw new Error('Session mode controller is disposed');
      if (inFlight.has(sessionId)) throw new Error('Session mode change already in flight');
      if (change.field === 'towerMode' && change.value && !(await allowTowerEnable())) {
        throw new Error('Tower mode is not enabled');
      }

      const state = stateFor(sessionId);
      const previousValue = modeValue(state, change.field);
      const previousConfidence = state.confidence;
      const fieldVersion = state.fieldVersions[change.field];
      const generation = bumpGeneration(sessionId);
      setModeValue(state, change);
      state.confidence = 'accepted-locally';
      state.pendingField = change.field;
      state.error = undefined;
      inFlight.add(sessionId);

      try {
        await options.writeMode(sessionId, change);
        if (!isCurrent(sessionId, generation)) return;
        state.pendingField = undefined;
      } catch (error) {
        if (isCurrent(sessionId, generation)) {
          state.pendingField = undefined;
          if (isBusinessRejection(error)) {
            if (state.fieldVersions[change.field] === fieldVersion) {
              restoreModeValue(state, change.field, previousValue);
              state.confidence = previousConfidence;
            }
            state.error = { kind: 'rejected', message: errorMessage(error) };
          } else {
            state.error = { kind: 'uncertain' };
          }
        }
        throw error;
      } finally {
        if (isCurrent(sessionId, generation)) inFlight.delete(sessionId);
      }
    },
    applyEvent(sessionId: string, patch: KimiWebSessionModePatch, context: KimiWebFrameContext) {
      if (disposed) return;
      const state = stateFor(sessionId);
      if (isOlderFrame(state, context)) return;

      const identityChanged = Boolean(
        state.frame?.epoch && context.epoch && state.frame.epoch !== context.epoch,
      );
      if (identityChanged && state.frame?.epoch) state.supersededEpochs.add(state.frame.epoch);
      state.frame = context;
      if (identityChanged) state.confidence = 'stale';
      if (!hasModePatch(patch)) return;

      applyPatch(state, patch);
      state.confidence = 'confirmed';
      state.error = undefined;
    },
    markStale(sessionId: string) {
      const state = sessions.get(sessionId);
      if (state) state.confidence = 'stale';
    },
    resetSession(sessionId: string) {
      sessions.delete(sessionId);
      inFlight.delete(sessionId);
      bumpGeneration(sessionId);
    },
    dispose() {
      disposed = true;
      sessions.clear();
      inFlight.clear();
      generations.clear();
    },
  };
}
