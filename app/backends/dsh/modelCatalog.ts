/**
 * dsh model catalog + selection surface (Todo 29).
 *
 * Owns the pure, testable model-domain logic the composer and provider UI
 * consume, mirroring the kimiWeb model surface (`kimiWebAdapter.modelResponse`
 * / `modelSelection.ts`) so the shared components see ONE shape:
 *
 *   - `session/modelCatalog` (docs/dsh.md §7.1/§10, live-verified: provider
 *     `deepseek-official`, models `deepseek-flash` / `deepseek-v4-pro`, reasoning
 *     ladder `off|low|high|max`, default `high`) is normalized into the shared
 *     {@link BackendProviderResponse} type — never a dsh-only shape.
 *   - the UI composite id (`provider/model[:effort]`) is kept separate from the
 *     wire alias: the wire `session/selectModel` request is
 *     `{sessionId, provider, model, reasoningEffort?}` and the UI value is the
 *     composite string, so a display rename can never leak into the wire.
 *   - the current selection is read ONLY from `projections.modelSelection.lastUsed`
 *     (mount read-back from `session/get`), never fabricated locally.
 *
 * Clamp-off is a first-class NONE state, not a model: dsh reports
 * {@link DSH_MODEL_SELECTION_NONE} (`__none__`) when a selection is disabled, and
 * a missing projection is the other none form. Both normalize to `undefined`
 * (readers) / `null` (controller state) so the UI can render an explicit empty
 * selector instead of a fake "current model" (misleading_success_output guard).
 *
 * The catalog parser is the one landed on the adapter (`normalizeDshModelCatalog`)
 * and is re-exported here rather than forked, so a catalog change lands in one
 * place. `dshModelSurface` intentionally reproduces the adapter's private
 * `dshModelResponse` projection; the consistency test in `./modelCatalog.test.ts`
 * pins the two together against the same catalog.
 */

import type {
  BackendProviderInfo,
  BackendProviderModel,
  BackendProviderResponse,
} from '../../types/backend-domain';
import {
  normalizeDshModelCatalog,
  type DshCatalogProvider,
  type DshModelInfo,
  type DshModelSelection,
} from './dshAdapter';

export { normalizeDshModelCatalog };
export type { DshCatalogProvider, DshModelInfo, DshModelSelection };

/**
 * dsh's server-side clamp-off read-back. When a selection is disabled the
 * projection reports this sentinel in place of a provider/model pair; it is NOT
 * a valid model and must never be rendered as the current selection.
 */
export const DSH_MODEL_SELECTION_NONE = '__none__';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

function isSentinel(value: string): boolean {
  return value === DSH_MODEL_SELECTION_NONE;
}

/**
 * A selection is usable only when both ids are present and neither is the
 * clamp-off sentinel. This is the single gate every reader/controller path uses.
 */
export function isDshModelSelectionUsable(value: unknown): value is DshModelSelection {
  if (!isRecord(value)) return false;
  const provider = readString(value, 'provider');
  const model = readString(value, 'model');
  if (!provider || !model || isSentinel(provider) || isSentinel(model)) return false;
  const effort = value.reasoningEffort;
  return effort === undefined || typeof effort === 'string';
}

/** Normalize a wire model ref, returning `undefined` for a sentinel/empty ref. */
function normalizeModelRef(value: unknown): DshModelSelection | undefined {
  if (!isDshModelSelectionUsable(value)) return undefined;
  const provider = readString(value as Record<string, unknown>, 'provider');
  const model = readString(value as Record<string, unknown>, 'model');
  const effort = readString(value as Record<string, unknown>, 'reasoningEffort');
  return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
}

/**
 * Locate the projections `values` container across the shapes dsh actually
 * returns: a `session/follow` snapshot, a mux item frame wrapping it under
 * `value`, a `session/get` projection baseline (`{projections:{asOfSeq,values}}`),
 * or a bare `{values}` / `{modelSelection}` object.
 */
function projectionValues(source: unknown): Record<string, unknown> | undefined {
  if (!isRecord(source)) return undefined;
  const unwrapped = isRecord(source.value) ? source.value : source;
  const projections = isRecord(unwrapped.projections) ? unwrapped.projections : undefined;
  if (projections) {
    return isRecord(projections.values) ? projections.values : projections;
  }
  if (isRecord(unwrapped.values)) return unwrapped.values;
  return unwrapped;
}

/**
 * Read the CURRENT selection from `projections.modelSelection.lastUsed`.
 * Returns `undefined` for a missing projection or the `__none__` clamp-off
 * sentinel — never a fabricated model.
 */
export function readDshProjectionModelSelection(source: unknown): DshModelSelection | undefined {
  const values = projectionValues(source);
  if (!values) return undefined;
  const selection = values.modelSelection;
  if (!isRecord(selection)) return undefined;
  return normalizeModelRef(selection.lastUsed);
}

/**
 * Read the `{selected}` envelope echoed by `session/selectModel`
 * (docs/dsh.md §7.1: `{selected:{provider,model,reasoningEffort?}}`).
 * A `__none__` echo normalizes to `undefined`.
 */
export function readDshSelectModelResponse(value: unknown): DshModelSelection | undefined {
  if (!isRecord(value)) return undefined;
  const root =
    isRecord(value.value) && isRecord((value.value as Record<string, unknown>).selected)
      ? (value.value as Record<string, unknown>)
      : value;
  return normalizeModelRef(root.selected);
}

/**
 * Normalize the catalog into the shared {@link BackendProviderResponse} surface
 * (identical in shape to the kimiWeb model response): each model carries a
 * `variants` map of the reasoning ladder with the catalog default flagged.
 */
export function dshModelSurface(providers: readonly DshCatalogProvider[]): BackendProviderResponse {
  const all: BackendProviderInfo[] = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: Object.fromEntries(
      provider.models.map((model): [string, BackendProviderModel] => [
        model.id,
        {
          id: model.id,
          name: model.name,
          providerID: provider.id,
          ...(model.contextLimit === undefined
            ? {}
            : { limit: { context: model.contextLimit } }),
          ...(model.reasoningEfforts.length
            ? {
                variants: Object.fromEntries(
                  model.reasoningEfforts.map((effort) => [
                    effort,
                    { default: effort === model.defaultReasoningEffort },
                  ]),
                ),
              }
            : {}),
          capabilities: { reasoning: true, toolcall: true, attachment: false },
        },
      ]),
    ),
  }));
  const defaults: Record<string, string> = {};
  for (const provider of providers) {
    const first = provider.models[0];
    if (first) defaults[provider.id] = first.id;
  }
  return { all, connected: providers.map((provider) => provider.id), default: defaults };
}

/**
 * Parse a UI composite id (`provider/model` or `provider/model:effort`) into its
 * wire parts. Returns `undefined` for a malformed, empty, or `__none__` id, so a
 * sentinel can never round-trip back into a selectable model.
 */
export function parseDshCompositeModelId(id: string): DshModelSelection | undefined {
  const trimmed = id.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  const provider = trimmed.slice(0, slash).trim();
  let rest = trimmed.slice(slash + 1);
  let effort = '';
  const colon = rest.lastIndexOf(':');
  if (colon > 0 && colon < rest.length - 1) {
    effort = rest.slice(colon + 1).trim();
    rest = rest.slice(0, colon);
  }
  const model = rest.trim();
  const candidate = { provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
  return isDshModelSelectionUsable(candidate) ? candidate : undefined;
}

/** Encode a usable selection as the UI composite id (inverse of the parser). */
export function dshCompositeModelId(selection: DshModelSelection): string | undefined {
  if (!isDshModelSelectionUsable(selection)) return undefined;
  const effort = selection.reasoningEffort?.trim();
  return `${selection.provider}/${selection.model}${effort ? `:${effort}` : ''}`;
}

/** Wire `session/selectModel` args (`args.request.*`, docs/dsh.md §7.1). */
export type DshSelectModelRequest = {
  sessionId: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
};

/**
 * Build the `session/selectModel` request from a UI composite id. An explicit
 * thought level wins over the composite suffix (the composer keeps the two
 * controls separate). Throws instead of sending a payload with no usable model.
 */
export function dshSelectModelRequest(
  sessionId: string,
  selectedModel: string,
  thoughtLevel?: string,
): DshSelectModelRequest {
  const session = sessionId.trim();
  if (!session) throw new Error('dsh session/selectModel requires a session id.');
  const parsed = parseDshCompositeModelId(selectedModel);
  if (!parsed) {
    throw new Error(
      `dsh session/selectModel received no usable composite model id: ${JSON.stringify(selectedModel)}`,
    );
  }
  const effort = thoughtLevel?.trim() || parsed.reasoningEffort;
  return {
    sessionId: session,
    provider: parsed.provider,
    model: parsed.model,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

/**
 * Compose a concise card label that never repeats the provider name (fixes
 * index「模型、权限与提供商」第 1 行): a `provider/Model` or `provider Model`
 * label is reduced to the model part.
 */
export function dshModelDisplayName(providerName: string, modelName: string): string {
  const name = modelName.trim();
  if (!name) return '';
  const provider = providerName.trim();
  if (!provider) return name;
  for (const prefix of [`${provider}/`, `${provider} `]) {
    if (name.startsWith(prefix)) {
      const stripped = name.slice(prefix.length).trim();
      if (stripped) return stripped;
    }
  }
  return name;
}

/**
 * Explicit none/missing state. `selection: null` means "no current model" — it
 * is NOT an empty-string model and must render as an empty selector.
 */
export type DshModelSelectionState = {
  selection: DshModelSelection | null;
  known: boolean;
};

/** Injected wire collaborators: the real `session/selectModel` and `session/get` are network. */
export type DshModelSelectionCollaborators = {
  /** Write via `session/selectModel`; returns the raw response envelope. */
  selectModel: (request: DshSelectModelRequest) => Promise<unknown>;
  /** Mount read-back: `session/get` (or a follow snapshot) carrying projections. */
  getProjections: (sessionId: string) => Promise<unknown>;
};

export type DshModelSelectionController = {
  /** Current in-memory footprint; `selection: null` is an explicit none state. */
  getState(): DshModelSelectionState;
  /** Select a model: writes the wire, then updates the footprint from the echo. */
  select(sessionId: string, selectedModel: string, thoughtLevel?: string): Promise<DshModelSelection>;
  /** Mount read-back: the projection is authoritative over any local footprint. */
  mountReadBack(sessionId: string): Promise<DshModelSelectionState>;
};

/**
 * Stateful selection footprint for one session.
 *
 * `select` never reports success on a failed write (the footprint only moves
 * after the wire resolves) and `mountReadBack` replaces the footprint with the
 * projection — including collapsing to `null` for `__none__`/missing, so a stale
 * local echo can never outlive the server truth (stale_state + misleading_success).
 */
export function createDshModelSelectionController(
  collaborators: DshModelSelectionCollaborators,
): DshModelSelectionController {
  let selection: DshModelSelection | null = null;
  let known = false;

  const getState = (): DshModelSelectionState => ({ selection, known });

  return {
    getState,
    async select(sessionId, selectedModel, thoughtLevel) {
      const request = dshSelectModelRequest(sessionId, selectedModel, thoughtLevel);
      const response = await collaborators.selectModel(request);
      const echoed = readDshSelectModelResponse(response);
      selection =
        echoed ??
        ({
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        } satisfies DshModelSelection);
      known = true;
      return selection;
    },
    async mountReadBack(sessionId) {
      const projected = readDshProjectionModelSelection(
        await collaborators.getProjections(sessionId),
      );
      selection = projected ?? null;
      known = true;
      return getState();
    },
  };
}
