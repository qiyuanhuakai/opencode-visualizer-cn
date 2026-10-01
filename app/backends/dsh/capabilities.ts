/**
 * dsh capability registry.
 *
 * `DSH_CAPABILITIES` in `./dshAdapter.ts` is the **single source of truth** for
 * the dsh capability matrix. This module never copies it into a competing
 * matrix: {@link DSH_CAPABILITY_REGISTRY} is derived from the adapter matrix at
 * module load, and `capabilities.test.ts` pins every derived value back to
 * `DSH_CAPABILITIES` so the two cannot drift (stale-state guard).
 *
 * What the registry adds on top of the positive matrix is the **negative
 * surface**: every capability dsh reports `false`. For each one the UI must not
 * render a fake entry point ("假入口"), so the registry records the enforcement
 * anchor — the production file + symbol that hides (or fails-loud instead of
 * silently succeeding) and the test that pins it. A guard test fails when a
 * false capability has no anchor, and when an anchor symbol no longer exists in
 * its file (no dead links).
 *
 * Dimensions and semantics follow `docs/dsh.md` §10 (可用性矩阵) and the
 * kimi-web lessons in `docs/kimi-web-adaptation-fixes.md`
 * 「协议、能力与后端切换」.
 */
import type { BackendCapabilities } from '../types';
import { DSH_CAPABILITIES } from './dshAdapter';

/** Every capability key of the shared contract. */
export type DshCapabilityKey = keyof BackendCapabilities;

/** The boolean-valued capability keys (excludes `sessionManagementMode`). */
export type DshBooleanCapabilityKey = {
  [K in keyof BackendCapabilities]: BackendCapabilities[K] extends boolean ? K : never;
}[keyof BackendCapabilities];

/**
 * The capability registry, derived 1:1 from the adapter matrix. Read-only so a
 * consumer can never mutate the shared source through the registry.
 */
export const DSH_CAPABILITY_REGISTRY: Readonly<BackendCapabilities> = Object.freeze({
  ...DSH_CAPABILITIES,
});

/**
 * The negative capability set declared by the plan: capabilities that must not
 * appear anywhere in dsh's UI (投票/深研/计时器/压缩/Recents/工作区/web/tabby).
 * The two that correspond to real dsh capability bits are 压缩
 * (`sessionCompact`) and 工作区 (`worktrees`); see {@link DSH_EXCLUDED_UI_FEATURES}.
 *
 * This literal list is pinned to the runtime-derived false set by the test, so
 * flipping a bit in `DSH_CAPABILITIES` without updating the registry fails.
 */
export const DSH_FALSE_CAPABILITY_KEYS = [
  'worktrees',
  'sessionRevert',
  'sessionDelete',
  'sessionCompact',
  'questions',
  'todos',
] as const satisfies readonly DshBooleanCapabilityKey[];

/** Union of the capabilities dsh reports `false`. */
export type DshFalseCapability = (typeof DSH_FALSE_CAPABILITY_KEYS)[number];

/**
 * The other `false` bits in `DSH_CAPABILITIES` are **behavioral toggles**, not
 * unsupported capabilities: `false` is the permissive/default branch (any
 * attachment type, no picker session creation, no synthetic PTY event, no
 * artifact refresh on success, non-strict sandbox paths). They grant nothing
 * and hide no entry point, so they are not part of the negative capability set
 * — but they ARE pinned by the partition test below so no `false` bit escapes
 * classification.
 */
export const DSH_BEHAVIORAL_FALSE_FLAGS = [
  'imageAttachmentsOnly',
  'projectPickerCreatesSession',
  'ptyExitRequiresSyntheticEvent',
  'ptyRefreshArtifactsOnSuccess',
  'strictSandboxPaths',
] as const satisfies readonly DshBooleanCapabilityKey[];

/**
 * Runtime-derive every `false` boolean bit from a matrix (defaults to the dsh
 * registry). The test asserts this is exactly the disjoint union of the
 * negative capability set and the behavioral toggles — the derivation is what
 * makes "the registry mirrors the adapter matrix" true rather than asserted by
 * hand.
 */
export function deriveDshBooleanFalseKeys(
  matrix: BackendCapabilities = DSH_CAPABILITY_REGISTRY,
): DshBooleanCapabilityKey[] {
  return (Object.keys(matrix) as DshCapabilityKey[])
    .filter((key): key is DshBooleanCapabilityKey => matrix[key] === false)
    .sort();
}

/** How a false capability is kept out of the UI (or kept from succeeding). */
export type DshCapabilityEnforcementKind =
  /** The shared UI never renders the affordance for dsh. */
  | 'ui-hidden'
  /** The affordance exists but the adapter rejects it with a typed error. */
  | 'fail-loud'
  /** dsh wires no protocol surface, so the shared loader short-circuits. */
  | 'no-surface';

export type DshCapabilityEnforcement = {
  readonly kind: DshCapabilityEnforcementKind;
  /** Project-relative production file the gate lives in. */
  readonly file: string;
  /** Exact token that must exist in `file` (dead-link guard). */
  readonly symbol: string;
  /** Project-relative test that pins the hiding / rejection / absence. */
  readonly test: string;
  readonly summary: string;
};

/**
 * Enforcement anchor for every false capability. Exhaustive by type: adding a
 * `false` bit to {@link DSH_FALSE_CAPABILITY_KEYS} without an anchor here is a
 * compile error, and the runtime false set is pinned to that list by the test.
 */
export const DSH_FALSE_CAPABILITY_ENFORCEMENT: Record<DshFalseCapability, DshCapabilityEnforcement> =
  {
    worktrees: {
      kind: 'ui-hidden',
      file: 'app/App.vue',
      symbol: ':worktrees-enabled="activeBackendCapabilities.worktrees"',
      test: 'app/components/TopPanel.test.ts',
      summary:
        'App.vue forwards the matrix bit to TopPanel, whose worktree action buttons render only when worktreesEnabled !== false (TopPanel.test.ts pins both directions).',
    },
    sessionRevert: {
      kind: 'fail-loud',
      file: 'app/backends/dsh/dshAdapter.ts',
      symbol: "unsupported('session revert'",
      test: 'app/backends/dsh/dshAdapter.test.ts',
      summary:
        'dsh exposes no revert endpoint; revertSession/unrevertSession reject with a typed DshUnsupportedError, so a revert affordance can never silently succeed.',
    },
    sessionDelete: {
      kind: 'ui-hidden',
      file: 'app/App.vue',
      symbol: 'delete: activeBackendCapabilities.sessionDelete',
      test: 'app/components/TopPanel.test.ts',
      summary:
        'App.vue forwards sessionDelete=false into TopPanel session-action capabilities (delete hidden); deleteSession() also fails loud as a second line of defence.',
    },
    sessionCompact: {
      kind: 'no-surface',
      file: 'app/App.vue',
      symbol: "kimiWebCapabilities.isAvailable('compact')",
      test: 'app/backends/dsh/dshAdapter.test.ts',
      summary:
        'Compaction is a Kimi-only runtime-gated action; dsh has no compact endpoint or compact adapter method, so no compact affordance is wired.',
    },
    questions: {
      kind: 'no-surface',
      file: 'app/composables/useQuestions.ts',
      symbol: 'if (!replyQuestion) throw new Error(',
      test: 'app/backends/dsh/dshAdapter.test.ts',
      summary:
        'dsh implements neither replyQuestion nor listPendingQuestions; the shared question surface short-circuits, so no question entry can appear.',
    },
    todos: {
      kind: 'no-surface',
      file: 'app/composables/useTodos.ts',
      symbol: 'getSessionTodos ? await getSessionTodos(id, directory) : []',
      test: 'app/backends/dsh/dshAdapter.test.ts',
      summary:
        'dsh does not implement getSessionTodos; the shared todo loader falls back to an empty list, so no todo panel is populated.',
    },
  };

/**
 * The named negative UI features from the plan, mapped onto the authoritative
 * false-capability bits where one exists. Features with `capability: null` have
 * no Vis entry point for any backend (verified absent from the repository), so
 * there is nothing to hide and no dead link can exist.
 */
export type DshExcludedUiFeature = {
  readonly id: string;
  readonly label: string;
  readonly capability: DshFalseCapability | null;
  readonly note: string;
};

export const DSH_EXCLUDED_UI_FEATURES: readonly DshExcludedUiFeature[] = [
  {
    id: 'vote',
    label: '投票',
    capability: null,
    note: 'No Vis entry point exists for any backend; dsh wires neither a question nor a vote request surface.',
  },
  {
    id: 'deep-research',
    label: '深研',
    capability: null,
    note: 'No Vis entry point; not a BackendCapabilities dimension and absent from the dsh availability matrix.',
  },
  {
    id: 'timer',
    label: '计时器',
    capability: null,
    note: 'No Vis entry point; dsh exposes no timer surface.',
  },
  {
    id: 'compact',
    label: '压缩',
    capability: 'sessionCompact',
    note: 'Kimi-only runtime-gated action; dsh wires no compact affordance (see DSH_FALSE_CAPABILITY_ENFORCEMENT.sessionCompact).',
  },
  {
    id: 'recents',
    label: 'Recents',
    capability: null,
    note: 'No Vis "Recents" surface; dsh sessions land in the shared project tree, not a recents list.',
  },
  {
    id: 'workspace',
    label: '工作区',
    capability: 'worktrees',
    note: 'worktrees=false hides every worktree affordance (see DSH_FALSE_CAPABILITY_ENFORCEMENT.worktrees).',
  },
  {
    id: 'web',
    label: 'web',
    capability: null,
    note: 'No Vis entry point; dsh web-surface features are not mirrored in Vis.',
  },
  {
    id: 'tabby',
    label: 'tabby',
    capability: null,
    note: 'No Vis entry point; not present anywhere in the repository.',
  },
];
