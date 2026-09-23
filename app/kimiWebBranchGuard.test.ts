/**
 * Todo 12 — backendKind branch-coverage guard.
 *
 * Enumerates every backend-kind branch point in `app/` and asserts:
 *   1. every inventoried branch site still exists at its recorded multiplicity
 *      (drift = inventory out of date),
 *   2. every backend-kind branch line found in production source is CLAIMED by
 *      an inventory entry — a new / unregistered branch line FAILS the guard,
 *   3. every narrow `backendKind?: 'opencode' | 'codex' | 'acp'` union that
 *      omits `'kimi-web'` is registered,
 *   4. every entry carries a registered owner todo and a kimi-web disposition
 *      (`handled` / `rejected` / `pending`); entries owned by already-done todos
 *      must be `handled`/`rejected` and prove it with a kimi signal,
 *   5. the real adapter in `registry.ts` is explicitly registered for
 *      `'kimi-web'` (no silent OpenCode fallback at the registry seam).
 *
 * HARD GATE IS DEFERRED TO TODO 23. At Todo 12 the acceptance bar is inventory
 * completeness + every branch having a registered owner + red-on-unregistered.
 * The "every UI-required branch is implemented" gate flips when
 * `STRICT_KIMI_COVERAGE` becomes `true` (see the TODO-23 marker test below).
 *
 * The inventory is documented for humans at:
 *   .omo/evidence/kimi-web-adapt/task-12-branches.md
 *
 * // allow: SIZE_OK — pure-data-table inventory; logic is a thin verifier.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_DIR = dirname(fileURLToPath(import.meta.url));

// TODO-23: strict mode — every UI-required branch handles kimi-web explicitly.
const STRICT_KIMI_COVERAGE = true;

const OWNER_TODOS = [6, 7, 10, 11, 15, 16, 17, 18, 19, 20, 21, 25] as const;
// Todo 23: all implementation todos are committed, so every entry proves its kimi disposition.
const DONE_TODOS = new Set<number>([6, 7, 10, 11, 15, 16, 17, 18, 19, 20, 21, 25]);

const KIND_LITERALS = `(?:opencode|codex|acp|kimi-web)`;
const OPERAND = `(?:[A-Za-z_$][\\w$]*(?:\\([^()]*\\))?(?:\\.[A-Za-z_$][\\w$]*)*)`;
const CMP_RE = new RegExp(
  `(${OPERAND})\\s*(===|!==)\\s*(['"]${KIND_LITERALS}['"])|(['"]${KIND_LITERALS}['"])\\s*(===|!==)\\s*(${OPERAND})`,
  'g',
);
const CASE_RE = new RegExp(`\\bcase\\s+(['"]${KIND_LITERALS}['"])\\s*:`);
const UNION_RE = new RegExp(`backendKind\\s*\\??:\\s*[^;\\n]*`);
// A discriminant must be an actual BackendKind carrier, never a lookalike
// (archive `kind`, message `mode`, provider id, WS `activeTab`, ...).
const DISCRIMINANT_RE =
  /^(?:[\w$]+\.)*(?:activeBackendKind|loginBackendKind|configuredBackendKind|storedBackendKind|preservedBackendKind|backendKind)(?:\.value)?$|^previousCacheContext\.backend$|^preflight\.backend$|^getActiveBackendKind\(\)$|^backend\(\)\.kind$|^active\.kind$|^backend$|^storageGet\(StorageKeys\.auth\.backendKind\)$|^event\.newValue$/;

// Only these files own a backend-kind `switch`/`case`; a `switch` on a tab id
// (StatusMonitorModal `activeTab`) or archive kind is not a backend branch.
const SWITCH_BACKEND_FILES = new Set(['App.vue', 'composables/useBackendSessionLifecycle.ts']);

type Classification = 'ui-required' | 'capability-optional';
type Handling = 'handled' | 'rejected' | 'pending';

type BranchEntry = {
  /** file path relative to app/ */
  file: string;
  /** canonical `<operand><op><'literal'>` fingerprint (or `case:'kind'`) */
  fp: string;
  /** expected occurrences of the fingerprint in the file (entries may share a fp) */
  occurrences: number;
  classification: Classification;
  owner: number;
  handling: Handling;
  /** human context: enclosing symbol / line hints */
  sites: string;
  /** regex that must be present in the file when handling is handled/rejected */
  kimiSignal?: string;
};

type UnionEntry = {
  file: string;
  fp: string;
  owner: number;
  classification: Classification;
  handling: Handling;
  sites: string;
};

// ---------------------------------------------------------------------------
// INVENTORY (mirrors task-12-branches.md)
// ---------------------------------------------------------------------------
const BRANCHES: BranchEntry[] = [
  { file: 'App.vue', fp: "activeBackendKind.value!=='kimi-web'", occurrences: 4, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'goal/agent manager launch and stale-session callback guards', kimiSignal: 'KimiWebAgentManager' },
  { file: 'App.vue', fp: "activeBackendKind.value!=='kimi-web'", occurrences: 2, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'Kimi Git metadata hydration queue and probe guard', kimiSignal: 'scheduleKimiTopPanelGitInfoHydration' },
  { file: 'App.vue', fp: "activeBackendKind.value==='kimi-web'", occurrences: 2, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'Kimi Git metadata probe backend and result fence', kimiSignal: 'hydrateKimiTopPanelGitInfo' },
  { file: 'composables/useBackendMessageSend.ts', fp: "params.activeBackendKind.value==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 18, handling: 'handled', sites: 'invalidate in-flight send on Kimi session switch', kimiSignal: 'requestFence.invalidate' },
  { file: 'composables/useBackendMessageSend.ts', fp: "params.activeBackendKind.value==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 18, handling: 'handled', sites: 'dispatch supported Kimi slash commands before model send', kimiSignal: 'dispatchKimiWebSlash' },
  // ----- app/App.vue — boot / serial chain (11→25→16→19) -----
  { file: 'App.vue', fp: "activeBackendKind.value!=='acp'", occurrences: 5, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'acp-only guards 3985/4023/7665/7675/7898' },
  { file: 'App.vue', fp: "activeBackendKind.value!=='codex'", occurrences: 5, classification: 'capability-optional', owner: 19, handling: 'handled', sites: 'codex-only dialog watchers 2679/2694/2739/2753/2768' },
  { file: 'App.vue', fp: "activeBackendKind.value!=='codex'", occurrences: 4, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'agent defaults 3960; provider watch 7309; normalizeProjectDirectory 7718; pty.deleted 9665' },
  { file: 'App.vue', fp: "activeBackendKind.value!=='opencode'", occurrences: 2, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'opencode-only 1801 persistActiveOpenCodeSelection; 5295 hydrateReferencedSubagents' },
  { file: 'App.vue', fp: "activeBackendKind.value==='acp'", occurrences: 2, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'acp-only 4001/5103' },
  { file: 'App.vue', fp: "activeBackendKind.value==='acp'", occurrences: 1, classification: 'capability-optional', owner: 20, handling: 'handled', sites: 'completion notification 7578' },
  { file: 'App.vue', fp: "activeBackendKind.value==='codex'", occurrences: 1, classification: 'capability-optional', owner: 20, handling: 'handled', sites: 'completion notification 1725' },
  { file: 'App.vue', fp: "activeBackendKind.value==='codex'", occurrences: 2, classification: 'capability-optional', owner: 19, handling: 'handled', sites: 'codex approval replies 2359/2373' },
  { file: 'App.vue', fp: "activeBackendKind.value==='codex'", occurrences: 1, classification: 'capability-optional', owner: 16, handling: 'handled', sites: 'subagent history loadHistory 8898' },
  { file: 'App.vue', fp: "activeBackendKind.value!=='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 16, handling: 'handled', sites: 'kimi popup session fence isKimiWebPopupSession 7656 (tool/reasoning/subagent auto-popups + reconcile seam)', kimiSignal: "activeBackendKind.value !== 'kimi-web'" },
  { file: 'App.vue', fp: "activeBackendKind.value!=='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'resolveDefaultAgentModel skips agent defaults for kimi-web composer permission modes', kimiSignal: 'applyAgentDefaults' },
  { file: 'App.vue', fp: "activeBackendKind.value==='kimi-web'", occurrences: 5, classification: 'ui-required', owner: 19, handling: 'handled', sites: 'approval sendReply 2434; question sendReply 2488; question sendReject 2517; refresh gate 7886; reconcile isCurrent fence 7906 (approvals/questions wiring)', kimiSignal: 'reconcileKimiWebInteractions' },
  { file: 'App.vue', fp: "activeBackendKind.value!=='kimi-web'", occurrences: 5, classification: 'ui-required', owner: 19, handling: 'handled', sites: 'refresh gate 7895; pending watcher 7919; session-switch watch 7944; onSyncStateChange live 8101; onSessionEvent pending_interaction trigger (approvals/questions wiring)', kimiSignal: 'kimiWebInteractions' },
  { file: 'App.vue', fp: "activeBackendKind.value==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'fetchAgents keeps generic agent discovery empty while selecting the dedicated kimi-web permission option', kimiSignal: 'kimiWebAgentOptions' },
  { file: 'App.vue', fp: "activeBackendKind.value==='kimi-web'", occurrences: 5, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'hasAgentOptions; draft restore/write isolation; handleSelectedModeUpdate mode routing', kimiSignal: 'kimiWebAgentModeOptions' },
  { file: 'App.vue', fp: "activeBackendKind.value==='kimi-web'", occurrences: 3, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'Kimi slash command session guard and active composer client', kimiSignal: 'executeKimiWebSlashCommand' },
  { file: 'App.vue', fp: "activeBackendKind.value==='codex'", occurrences: 7, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'codex-only 2342/2904/3025/3154/5058/7278/8027' },
  { file: 'App.vue', fp: "activeBackendKind.value==='codex'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'fetchAgents codex collaboration-mode branch', kimiSignal: 'agentOptions.value = \\[\\]' },
  { file: 'App.vue', fp: "activeBackendKind.value==='opencode'", occurrences: 2, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'opencode-only 3596/3687' },
  { file: 'App.vue', fp: "activeBackendKind.value==='opencode'", occurrences: 1, classification: 'capability-optional', owner: 15, handling: 'handled', sites: 'opencode-only hydration 5328' },
  { file: 'App.vue', fp: "activeBackendKind==='acp'", occurrences: 3, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'composer acp props 175/195/196' },
  { file: 'App.vue', fp: "activeBackendKind==='codex'", occurrences: 5, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'composer codex props 74/167/172/188/213' },
  { file: 'App.vue', fp: "activeBackendKind==='kimi-web'", occurrences: 6, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'composer permission/mode/goal, card metadata, and file diff actions', kimiSignal: 'KimiWebComposerModes' },
  { file: 'App.vue', fp: "backend==='codex'", occurrences: 1, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'selectModel watch 7286' },
  { file: 'App.vue', fp: "backendKind!=='codex'", occurrences: 1, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'codex connection watch 7460' },
  { file: 'App.vue', fp: "case:'codex'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'currentBackendIdentity switch (kimi case present)', kimiSignal: "case 'kimi-web'" },
  { file: 'App.vue', fp: "case:'acp'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'currentBackendIdentity switch (kimi case present)', kimiSignal: "case 'kimi-web'" },
  { file: 'App.vue', fp: "case:'kimi-web'", occurrences: 1, classification: 'ui-required', owner: 11, handling: 'handled', sites: 'currentBackendIdentity switch 5688 (kimi bridge url identity)', kimiSignal: 'kimiWebBridgeUrl' },
  { file: 'App.vue', fp: "case:'opencode'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'currentBackendIdentity switch (kimi case present)', kimiSignal: "case 'kimi-web'" },
  { file: 'App.vue', fp: "configuredBackendKind==='acp'", occurrences: 1, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'effectiveBackendKind fallback 7614' },
  // ----- app/App.vue — login surface (Todo 11) -----
  { file: 'App.vue', fp: "loginBackendKind.value!=='acp'", occurrences: 1, classification: 'ui-required', owner: 11, handling: 'handled', sites: 'acp login agent refresh 2211 (kimi-web needs no agent fetch)', kimiSignal: "loginBackendKind.value !== 'acp'" },
  { file: 'App.vue', fp: "loginBackendKind.value==='acp'", occurrences: 2, classification: 'ui-required', owner: 11, handling: 'handled', sites: 'loginTitle 2227; handleLogin 9498', kimiSignal: "loginBackendKind.value === 'kimi-web'" },
  { file: 'App.vue', fp: "loginBackendKind.value==='codex'", occurrences: 2, classification: 'ui-required', owner: 11, handling: 'handled', sites: 'loginTitle 2225; handleLogin 9493', kimiSignal: "loginBackendKind.value === 'kimi-web'" },
  { file: 'App.vue', fp: "loginBackendKind.value==='kimi-web'", occurrences: 2, classification: 'ui-required', owner: 11, handling: 'handled', sites: 'loginTitle 2229; handleLogin 9503 (saveKimiWeb + startInitialization)', kimiSignal: 'saveKimiWeb' },
  { file: 'App.vue', fp: "loginBackendKind==='acp'", occurrences: 2, classification: 'ui-required', owner: 11, handling: 'handled', sites: 'login backend toggle 307/308', kimiSignal: "loginBackendKind === 'kimi-web'" },
  { file: 'App.vue', fp: "loginBackendKind==='codex'", occurrences: 3, classification: 'ui-required', owner: 11, handling: 'handled', sites: 'login toggle 298/299 + fields 355', kimiSignal: "loginBackendKind === 'kimi-web'" },
  { file: 'App.vue', fp: "loginBackendKind==='kimi-web'", occurrences: 3, classification: 'ui-required', owner: 11, handling: 'handled', sites: 'login toggle 316/317 + fields 374 (bridge url + bridge token + hint)', kimiSignal: 'kimiWebBridgeHint' },
  { file: 'App.vue', fp: "loginBackendKind==='opencode'", occurrences: 3, classification: 'ui-required', owner: 11, handling: 'handled', sites: 'login toggle 289/290 + fields 324', kimiSignal: "loginBackendKind === 'kimi-web'" },
  // ----- components -----
  { file: 'components/ProjectPicker.vue', fp: "getActiveBackendKind()==='codex'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'rejected', sites: 'listDirectory path split 263 (kimi-web explicit reject)', kimiSignal: 'Kimi Web does not support the project directory picker' },
  { file: 'components/ProjectPicker.vue', fp: "getActiveBackendKind()==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'rejected', sites: 'listDirectory kimi-web fail-closed', kimiSignal: 'Kimi Web does not support the project directory picker' },
  { file: 'components/ProviderManagerModal.vue', fp: "active.kind==='codex'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'supportsProviderConfigUpdates 979 (kimi-web explicit false)', kimiSignal: "active.kind === 'kimi-web'" },
  { file: 'components/ProviderManagerModal.vue', fp: "active.kind==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'supportsProviderConfigUpdates kimi-web gate (providers owned by kimi)', kimiSignal: "active.kind === 'kimi-web'" },
  { file: 'components/ProviderManagerModal.vue', fp: "backend().kind==='codex'", occurrences: 2, classification: 'ui-required', owner: 25, handling: 'rejected', sites: 'validateCustomProvider 1038; submit 1180 (unreachable for kimi: config surface gated off)', kimiSignal: "active.kind === 'kimi-web'" },
  { file: 'components/ProviderManagerModal.vue', fp: "props.backendKind!=='acp'", occurrences: 1, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'tabs 19' },
  { file: 'components/ProviderManagerModal.vue', fp: "props.backendKind==='acp'", occurrences: 1, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'acp auth pane 44' },
  { file: 'components/ProviderManagerModal.vue', fp: "props.backendKind==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'isKimiWebBackend 782 — mounts KimiWebProviderManager instead of the shared provider/model tabs (kimi owns providers via REST)', kimiSignal: 'KimiWebProviderManager' },
  { file: 'components/StatusMonitorModal.vue', fp: "activeBackendKind==='codex'", occurrences: 2, classification: 'ui-required', owner: 20, handling: 'handled', sites: 'codex summary grid / token usage 971/1121', kimiSignal: 'unsupportedKimiWeb' },
  { file: 'components/StatusMonitorModal.vue', fp: "activeBackendKind==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 20, handling: 'handled', sites: 'server tab meta/auth rows (capabilities + models_ready)', kimiSignal: 'kimiCapabilitiesText' },
  { file: 'components/StatusMonitorModal.vue', fp: "props.activeBackendKind!=='codex'", occurrences: 1, classification: 'capability-optional', owner: 20, handling: 'handled', sites: 'codex-only refresh 364' },
  { file: 'components/StatusMonitorModal.vue', fp: "props.activeBackendKind==='acp'", occurrences: 1, classification: 'capability-optional', owner: 20, handling: 'handled', sites: 'acp unsupported copy 89' },
  { file: 'components/StatusMonitorModal.vue', fp: "props.activeBackendKind==='codex'", occurrences: 1, classification: 'capability-optional', owner: 20, handling: 'handled', sites: 'codex skills sync 612' },
  { file: 'components/StatusMonitorModal.vue', fp: "props.activeBackendKind==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 20, handling: 'handled', sites: 'isKimiWebBackend: bridge-proxy refresh + bridge-state token tab', kimiSignal: 'refreshKimiWebStatus' },
  { file: 'components/ThreadBlock.vue', fp: "props.backendKind==='codex'", occurrences: 3, classification: 'capability-optional', owner: 21, handling: 'handled', sites: 'attachments/revert codex variants 205/359/379' },
  { file: 'components/ThreadBlock.vue', fp: "props.backendKind==='kimi-web'", occurrences: 7, classification: 'ui-required', owner: 21, handling: 'handled', sites: 'checkpoint fork/undo, permission display, and per-turn file diff controls', kimiSignal: 'loadMessageDiffs' },
  { file: 'components/ThreadBlock.vue', fp: "backendKind!=='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 21, handling: 'handled', sites: 'file diff availability guard', kimiSignal: 'hasMessageDiffs' },
  { file: 'components/OutputPanel.vue', fp: "backendKind==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 21, handling: 'handled', sites: 'propagate checkpoint action readiness to message cards', kimiSignal: 'kimiCardActionsReady' },
  { file: 'composables/backendMessageSend.kimiSlash.ts', fp: "params.activeBackendKind.value==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 18, handling: 'handled', sites: 'fence slash commands to the selected Kimi session', kimiSignal: 'parseKimiWebSlashCommand' },
  // ----- composables — message send (Todo 18) -----
  { file: 'composables/backendMessageSend.openCode.ts', fp: "preflight.backend==='acp'", occurrences: 1, classification: 'ui-required', owner: 18, handling: 'rejected', sites: 'acp mention parts 33 (kimi-web refused at runOpenCodeSend entry)', kimiSignal: "preflight.backend === 'kimi-web'" },
  { file: 'composables/backendMessageSend.openCode.ts', fp: "preflight.backend==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 18, handling: 'rejected', sites: 'runOpenCodeSend fail-closed 106 (kimi dispatches from backendMessageSend.kimiWeb.ts)', kimiSignal: "preflight.backend === 'kimi-web'" },
  { file: 'composables/backendMessageSend.preflight.ts', fp: "backend!=='codex'", occurrences: 1, classification: 'ui-required', owner: 18, handling: 'handled', sites: 'model availability gate 55 (kimi-web joins the skip)', kimiSignal: "backend !== 'kimi-web'" },
  { file: 'composables/backendMessageSend.preflight.ts', fp: "backend==='codex'", occurrences: 2, classification: 'ui-required', owner: 18, handling: 'handled', sites: 'model resolution 48; codex directory 65 (kimi-web skips both)', kimiSignal: "backend === 'kimi-web'" },
  { file: 'composables/backendMessageSend.preflight.ts', fp: "backend==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 18, handling: 'handled', sites: 'wire model resolution and default thinking selection', kimiSignal: "backend === 'kimi-web'" },
  { file: 'composables/backendMessageSend.preflight.ts', fp: "backend!=='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 18, handling: 'handled', sites: 'model availability gate 55', kimiSignal: "backend !== 'kimi-web'" },
  { file: 'composables/backendMessageSend.slash.ts', fp: "params.activeBackendKind.value!=='codex'", occurrences: 1, classification: 'capability-optional', owner: 18, handling: 'handled', sites: 'codex slash dispatch 7' },
  { file: 'composables/backendMessageSend.slash.ts', fp: "params.activeBackendKind.value==='codex'", occurrences: 1, classification: 'capability-optional', owner: 18, handling: 'handled', sites: 'codex slash current guard 18' },
  { file: 'composables/useBackendMessageSend.ts', fp: "preflight.backend==='codex'", occurrences: 1, classification: 'ui-required', owner: 18, handling: 'handled', sites: 'codex send dispatch 99', kimiSignal: "preflight.backend === 'kimi-web'" },
  { file: 'composables/useBackendMessageSend.ts', fp: "preflight.backend==='kimi-web'", occurrences: 2, classification: 'ui-required', owner: 18, handling: 'handled', sites: 'kimi-web send dispatch and failed-send draft restoration', kimiSignal: 'runKimiWebSend' },
  { file: 'composables/useBackendMessageSend.ts', fp: "params.activeBackendKind.value==='codex'", occurrences: 1, classification: 'capability-optional', owner: 18, handling: 'handled', sites: 'codex slash pre-dispatch 118' },
  { file: 'utils/defaultComposerMode.ts', fp: "backend==='codex'", occurrences: 1, classification: 'capability-optional', owner: 18, handling: 'handled', sites: 'default mode 4' },
  // ----- composables — activation (Todo 10) -----
  { file: 'composables/useBackendActivation.ts', fp: "options.credentials.backendKind.value==='codex'", occurrences: 1, classification: 'ui-required', owner: 10, handling: 'handled', sites: 'startInitialization kimi-web dispatch present', kimiSignal: "backendKind.value === 'kimi-web'" },
  { file: 'composables/useBackendActivation.ts', fp: "options.credentials.backendKind.value==='codex'", occurrences: 1, classification: 'ui-required', owner: 10, handling: 'handled', sites: 'abortInitialization (kimi transport disconnected before the codex check)', kimiSignal: 'disconnectKimiWebBackend' },
  { file: 'composables/useBackendActivation.ts', fp: "options.credentials.backendKind.value==='acp'", occurrences: 1, classification: 'ui-required', owner: 10, handling: 'handled', sites: 'startInitialization kimi-web dispatch present', kimiSignal: "backendKind.value === 'kimi-web'" },
  { file: 'composables/useBackendActivation.ts', fp: "options.credentials.backendKind.value==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 10, handling: 'handled', sites: 'startInitialization kimi-web dispatch', kimiSignal: 'activateKimiWeb' },
  // ----- composables — session lifecycle / actions / trees (Todo 17 / 25) -----
  { file: 'composables/useBackendSelectionBootstrap.ts', fp: "params.activeBackendKind.value==='codex'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'bootstrapSelection 24 (kimi-web explicit early return)', kimiSignal: "activeBackendKind.value === 'kimi-web'" },
  { file: 'composables/useBackendSelectionBootstrap.ts', fp: "params.activeBackendKind.value==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'bootstrapSelection kimi-web early return (bootstraps via bootstrapKimiWebWorkspace)', kimiSignal: "params.activeBackendKind.value === 'kimi-web'" },
  { file: 'composables/useBackendSessionActions.ts', fp: "backendKind==='acp'", occurrences: 4, classification: 'ui-required', owner: 17, handling: 'handled', sites: 'delete/archive/unarchive/rename 221/275/325/372', kimiSignal: "backendKind === 'kimi-web'" },
  { file: 'composables/useBackendSessionActions.ts', fp: "backendKind==='codex'", occurrences: 4, classification: 'ui-required', owner: 17, handling: 'handled', sites: 'delete/archive/unarchive/rename 217/279/329/377', kimiSignal: "backendKind === 'kimi-web'" },
  { file: 'composables/useBackendSessionActions.ts', fp: "backendKind==='kimi-web'", occurrences: 4, classification: 'ui-required', owner: 17, handling: 'handled', sites: 'delete/archive/unarchive/rename kimi branch (kimiWebApi :delete/:archive/:restore/profile)', kimiSignal: 'Kimi Web session' },
  { file: 'composables/useBackendSessionActions.ts', fp: "params.activeBackendKind.value!=='opencode'", occurrences: 2, classification: 'capability-optional', owner: 17, handling: 'handled', sites: 'opencode-only 404/432' },
  { file: 'composables/useBackendSessionActions.ts', fp: "params.activeBackendKind.value!=='kimi-web'", occurrences: 3, classification: 'ui-required', owner: 17, handling: 'handled', sites: 'whole-session fork/compact and local archive/title synchronization', kimiSignal: 'api.forkSession' },
  { file: 'composables/useBackendSessionActions.ts', fp: "params.activeBackendKind.value==='kimi-web'", occurrences: 2, classification: 'ui-required', owner: 17, handling: 'handled', sites: 'checkpoint fork and conversation undo through Kimi APIs', kimiSignal: 'forkSessionAtMessage' },
  { file: 'composables/useBackendSessionActions.ts', fp: "params.activeBackendKind.value==='codex'", occurrences: 2, classification: 'capability-optional', owner: 17, handling: 'handled', sites: 'fork/revert codex-only (capability false for kimi) 539/570' },
  { file: 'composables/useBackendSessionLifecycle.ts', fp: "case:'codex'", occurrences: 1, classification: 'ui-required', owner: 17, handling: 'handled', sites: 'sessionProjectIdForBackend switch 45', kimiSignal: "case 'kimi-web'" },
  { file: 'composables/useBackendSessionLifecycle.ts', fp: "case:'acp'", occurrences: 1, classification: 'ui-required', owner: 17, handling: 'handled', sites: 'sessionProjectIdForBackend switch 45', kimiSignal: "case 'kimi-web'" },
  { file: 'composables/useBackendSessionLifecycle.ts', fp: "case:'opencode'", occurrences: 1, classification: 'ui-required', owner: 17, handling: 'handled', sites: 'sessionProjectIdForBackend switch 45', kimiSignal: "case 'kimi-web'" },
  { file: 'composables/useBackendSessionLifecycle.ts', fp: "case:'kimi-web'", occurrences: 1, classification: 'ui-required', owner: 17, handling: 'rejected', sites: 'sessionProjectIdForBackend switch 45 explicit reject (kimi uses workspace_id)', kimiSignal: 'Kimi Web sessions use their workspace id' },
  { file: 'composables/useBackendSessionLifecycle.ts', fp: "params.activeBackendKind.value==='acp'", occurrences: 4, classification: 'ui-required', owner: 17, handling: 'handled', sites: 'create/reuse/create/openPicker 111/122/128/199', kimiSignal: "activeBackendKind.value === 'kimi-web'" },
  { file: 'composables/useBackendSessionLifecycle.ts', fp: "params.activeBackendKind.value==='codex'", occurrences: 4, classification: 'ui-required', owner: 17, handling: 'handled', sites: 'create/openPicker/abort 89/141/188/211', kimiSignal: "activeBackendKind.value === 'kimi-web'" },
  { file: 'composables/useBackendSessionLifecycle.ts', fp: "params.activeBackendKind.value==='kimi-web'", occurrences: 4, classification: 'ui-required', owner: 17, handling: 'handled', sites: 'create/reuse; picker existing-directory selection; handleProjectDirectorySelect; abort', kimiSignal: 'createKimiWebSessionInDirectory' },
  { file: 'composables/useBackendSessionTrees.ts', fp: "params.activeBackendKind.value==='acp'", occurrences: 2, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'tree routing 65/88', kimiSignal: "activeBackendKind.value === 'kimi-web'" },
  { file: 'composables/useBackendSessionTrees.ts', fp: "params.activeBackendKind.value==='codex'", occurrences: 2, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'tree routing 54/87', kimiSignal: "activeBackendKind.value === 'kimi-web'" },
  { file: 'composables/useBackendSessionTrees.ts', fp: "params.activeBackendKind.value==='kimi-web'", occurrences: 2, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'kimi-web mapped-project tree routing 65/89', kimiSignal: 'buildAcpTopPanelTreeData' },
  // ----- composables — history (Todo 15) -----
  { file: 'composables/useBackendSessionReload.ts', fp: "params.activeBackendKind.value==='codex'", occurrences: 2, classification: 'ui-required', owner: 15, handling: 'handled', sites: 'reloadSelectedSessionState 93/121 (kimi history branch 169 present)', kimiSignal: "activeBackendKind.value === 'kimi-web'" },
  { file: 'composables/useBackendSessionReload.ts', fp: "params.activeBackendKind.value==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 15, handling: 'handled', sites: 'reloadSelectedSessionState kimi Web history branch 169' },
  { file: 'composables/useBackendSessionReload.ts', fp: "previousCacheContext.backend!=='codex'", occurrences: 1, classification: 'capability-optional', owner: 15, handling: 'handled', sites: 'cache save guard 111' },
  { file: 'composables/useRootHistoryLoader.ts', fp: "options.activeBackendKind.value==='acp'", occurrences: 1, classification: 'capability-optional', owner: 15, handling: 'handled', sites: 'acp metadata refresh 108' },
  { file: 'composables/useLiveDescendantHistoryHydration.ts', fp: "backendKind==='opencode'", occurrences: 1, classification: 'capability-optional', owner: 15, handling: 'handled', sites: 'opencode-only scope 54' },
  // ----- composables — shared infra -----
  { file: 'composables/useAcpMessageBridge.ts', fp: "backendKind==='acp'", occurrences: 1, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'acp bridge bind 19 (else stop)' },
  { file: 'composables/useAcpTerminalAction.ts', fp: "options.activeBackendKind.value!=='acp'", occurrences: 1, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'acp-only 50' },
  { file: 'composables/useBackendSessionStatus.ts', fp: "params.activeBackendKind.value==='codex'", occurrences: 1, classification: 'capability-optional', owner: 21, handling: 'handled', sites: 'codex turn active 16' },
  { file: 'composables/useCodexMessageBridge.ts', fp: "params.activeBackendKind.value!=='codex'", occurrences: 10, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'codex-only bridge 137-259 (kimi must not wire)' },
  { file: 'composables/useCodexWorkspaceSync.ts', fp: "backendKind!=='codex'", occurrences: 1, classification: 'capability-optional', owner: 25, handling: 'handled', sites: 'codex-only workspace sync 27' },
  { file: 'composables/useFileTree.ts', fp: "backendKind==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 25, handling: 'handled', sites: 'usesAdapterFileTreeStatus keeps kimi file hydration on REST fs actions and out of PTY git scripts', kimiSignal: 'usesAdapterFileTreeStatus' },
  // ----- composables — credentials (Todo 7 DONE) -----
  { file: 'composables/useCredentials.ts', fp: "backendKind.value==='codex'", occurrences: 1, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'isConfigured 58', kimiSignal: "backendKind.value === 'kimi-web'" },
  { file: 'composables/useCredentials.ts', fp: "backendKind.value==='acp'", occurrences: 1, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'isConfigured 59', kimiSignal: "backendKind.value === 'kimi-web'" },
  { file: 'composables/useCredentials.ts', fp: "backendKind.value==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'isConfigured 62', kimiSignal: 'kimiWebBridgeUrl.value' },
  { file: 'composables/useCredentials.ts', fp: "storedBackendKind==='codex'", occurrences: 1, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'load 153', kimiSignal: "storedBackendKind === 'kimi-web'" },
  { file: 'composables/useCredentials.ts', fp: "storedBackendKind==='acp'", occurrences: 2, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'load 155/166', kimiSignal: "storedBackendKind === 'kimi-web'" },
  { file: 'composables/useCredentials.ts', fp: "storedBackendKind==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'load 154', kimiSignal: 'StorageKeys.auth.kimiWebBridgeUrl' },
  { file: 'composables/useCredentials.ts', fp: "preservedBackendKind==='codex'", occurrences: 1, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'clear 201', kimiSignal: "preservedBackendKind === 'kimi-web'" },
  { file: 'composables/useCredentials.ts', fp: "preservedBackendKind==='acp'", occurrences: 1, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'clear 205', kimiSignal: "preservedBackendKind === 'kimi-web'" },
  { file: 'composables/useCredentials.ts', fp: "preservedBackendKind==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'clear 209', kimiSignal: 'StorageKeys.auth.kimiWebBridgeToken' },
  { file: 'composables/useCredentials.ts', fp: "event.newValue==='codex'", occurrences: 1, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'storage listener 223', kimiSignal: "event.newValue === 'kimi-web'" },
  { file: 'composables/useCredentials.ts', fp: "event.newValue==='acp'", occurrences: 1, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'storage listener 223', kimiSignal: "event.newValue === 'kimi-web'" },
  { file: 'composables/useCredentials.ts', fp: "event.newValue==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 7, handling: 'handled', sites: 'storage listener 223', kimiSignal: "event.newValue === 'kimi-web'" },
  // ----- composables — desktop health (Todo 6 DONE) -----
  { file: 'composables/useDesktopBridgeVersion.ts', fp: "target.backendKind==='acp'", occurrences: 1, classification: 'ui-required', owner: 6, handling: 'handled', sites: 'health url acp 24', kimiSignal: "target.backendKind === 'kimi-web'" },
  { file: 'composables/useDesktopBridgeVersion.ts', fp: "target.backendKind==='kimi-web'", occurrences: 1, classification: 'ui-required', owner: 6, handling: 'handled', sites: 'health url kimi-web 30', kimiSignal: "kimiWebBridgeHttpUrl" },
  // ----- backends/registry.ts — explicit rejection seam + acp persistence helpers -----
  { file: 'backends/registry.ts', fp: "storageGet(StorageKeys.auth.backendKind)!=='acp'", occurrences: 1, classification: 'capability-optional', owner: 7, handling: 'handled', sites: 'getPersistedAcpBridgeUrl 51 (kimi has own default)', kimiSignal: 'DEFAULT_KIMI_WEB_BRIDGE_URL' },
  { file: 'backends/registry.ts', fp: "storageGet(StorageKeys.auth.backendKind)==='acp'", occurrences: 1, classification: 'capability-optional', owner: 7, handling: 'handled', sites: 'getPersistedAcpBridgeToken 73 (kimi has own default)', kimiSignal: 'DEFAULT_KIMI_WEB_BRIDGE_URL' },
];

const UNIONS: UnionEntry[] = [
  { file: 'components/ProviderManagerModal.vue', fp: "backendKind?:'opencode'|'codex'|'acp'", owner: 11, classification: 'ui-required', handling: 'handled', sites: 'prop 717 widened to BackendKind by Todo 11; union no longer present, kept as the decision record' },
  { file: 'composables/useAcpMessageBridge.ts', fp: "backendKind:'opencode'|'codex'|'acp'", owner: 25, classification: 'ui-required', handling: 'handled', sites: 'syncAcpMessageBridge param widened to BackendKind by Todo 23; union no longer present, kept as the decision record' },
];

const REGISTRATION = {
  file: 'backends/registry.ts',
  owner: 25,
  signals: ["'kimi-web': kimiWebAdapter", 'createKimiWebAdapter'],
  sites: "adapters['kimi-web'] production registration + fail-closed getBackendAdapter",
};

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------
function walkProductionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walkProductionFiles(p, out);
    } else if (/\.(ts|vue)$/.test(entry)) {
      if (entry.endsWith('.test.ts')) continue;
      if (entry.endsWith('test-helpers.ts')) continue;
      const rel = relative(APP_DIR, p);
      if (rel.startsWith('test/') || rel.startsWith('dev/')) continue;
      out.push(rel);
    }
  }
  return out;
}

function normalizeOperand(expr: string): string {
  return expr.replace(/\s+/g, '');
}

type Detected = { fp: string; line: number };

function detectBranches(file: string, content: string): Detected[] {
  const out: Detected[] = [];
  const switchFile = SWITCH_BACKEND_FILES.has(file);
  let lastSwitch = '';
  content.split('\n').forEach((text, i) => {
    const sw = text.match(/switch\s*\(([^)]*)\)/);
    if (sw) lastSwitch = sw[1].replace(/\s+/g, '');
    const isBackendSwitch = switchFile && /^(activeBackendKind\.value|kind)$/.test(lastSwitch);
    const caseMatch = text.match(CASE_RE);
    if (caseMatch && isBackendSwitch) {
      out.push({ fp: `case:${caseMatch[1].replace(/"/g, "'")}`, line: i + 1 });
      return;
    }
    for (const m of text.matchAll(CMP_RE)) {
      const expr = m[1] || m[6];
      const op = m[2] || m[5];
      const lit = m[3] || m[4];
      if (!expr || !op || !lit) continue;
      if (!DISCRIMINANT_RE.test(normalizeOperand(expr))) continue;
      out.push({ fp: `${normalizeOperand(expr)}${op}${lit.replace(/"/g, "'")}`, line: i + 1 });
    }
  });
  return out;
}

const files = walkProductionFiles(APP_DIR);
const fileContents = new Map(files.map((f) => [f, readFileSync(join(APP_DIR, f), 'utf8')]));

const expectedCounts = new Map<string, number>();
for (const e of BRANCHES) {
  const key = `${e.file}|||${e.fp}`;
  expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + e.occurrences);
}

const detectedByFile = new Map<string, Detected[]>();
const unknownBranches: string[] = [];
for (const [file, content] of fileContents) {
  const detected = detectBranches(file, content);
  detectedByFile.set(file, detected);
  for (const d of detected) {
    if (!expectedCounts.has(`${file}|||${d.fp}`)) {
      unknownBranches.push(`${file}:${d.line} → ${d.fp}`);
    }
  }
}

describe('kimi-web backend branch guard (Todo 12)', () => {
  it('every inventoried branch site exists at its recorded multiplicity', () => {
    const drift: string[] = [];
    for (const [key, expected] of expectedCounts) {
      const file = key.split('|||')[0] ?? '';
      const fp = key.slice(file.length + 3);
      const actual = (detectedByFile.get(file) ?? []).filter((d) => d.fp === fp).length;
      if (actual !== expected) drift.push(`${key} expected ${expected}, found ${actual}`);
    }
    expect(drift).toEqual([]);
  });

  it('fails when a branch point appears that is not in the inventory', () => {
    expect(unknownBranches).toEqual([]);
  });

  it('every narrow backendKind union that omits kimi-web is registered', () => {
    const unregisteredUnions: string[] = [];
    for (const [file, content] of fileContents) {
      for (const line of content.split('\n')) {
        if (!UNION_RE.test(line)) continue;
        if (line.includes('kimi-web')) continue;
        if (!/'opencode'/.test(line) && !/"opencode"/.test(line)) continue;
        const matched = (line.match(UNION_RE)?.[0] ?? line).replace(/[;,]\s*$/, '');
        const fp = matched.replace(/\s+/g, '').replace(/"/g, "'");
        if (!UNIONS.some((u) => u.file === file && u.fp === fp)) {
          unregisteredUnions.push(`${file} → ${line.trim()}`);
        }
      }
    }
    expect(unregisteredUnions).toEqual([]);
  });

  it('every branch entry carries a registered owner todo', () => {
    const bad = BRANCHES.filter((e) => !(OWNER_TODOS as readonly number[]).includes(e.owner));
    expect(bad.map((e) => `${e.file}::${e.fp} owner=${e.owner}`)).toEqual([]);
  });

  it('every branch entry has an explicit kimi-web disposition (no unclassified silent fallback)', () => {
    const valid = new Set<Handling>(['handled', 'rejected', 'pending']);
    const unclassified = BRANCHES.filter((e) => !valid.has(e.handling));
    expect(unclassified.map((e) => `${e.file}::${e.fp}`)).toEqual([]);
  });

  it('entries owned by already-done todos prove their kimi handling', () => {
    const violations: string[] = [];
    for (const e of BRANCHES.filter((entry) => DONE_TODOS.has(entry.owner))) {
      if (e.handling === 'pending') {
        violations.push(`${e.file}::${e.fp} owned by done todo ${e.owner} is still pending`);
        continue;
      }
      if (e.kimiSignal) {
        const content = fileContents.get(e.file) ?? '';
        if (!new RegExp(e.kimiSignal).test(content)) {
          violations.push(`${e.file}::${e.fp} missing kimi signal /${e.kimiSignal}/`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('registry explicitly registers kimi-web without an OpenCode fallback', () => {
    const content = fileContents.get(REGISTRATION.file) ?? '';
    const missing = REGISTRATION.signals.filter((s) => !content.includes(s));
    expect(missing).toEqual([]);
  });

  it('TODO-23 strict mode: all UI-required branches handle kimi-web (deferred, not skipped)', () => {
    const pendingUiRequired = BRANCHES.filter(
      (e) => e.classification === 'ui-required' && e.handling === 'pending',
    );
    if (STRICT_KIMI_COVERAGE) {
      // Todo 23 flips this on; any remaining pending UI-required branch is red.
      expect(pendingUiRequired.map((e) => `${e.file}::${e.fp} (owner ${e.owner})`)).toEqual([]);
      return;
    }
    // Todo 12 non-strict: the mechanism must SEE the pending set, and every
    // pending UI-required branch must be registered against a real owner todo.
    expect(pendingUiRequired.length).toBeGreaterThan(0);
    const unowned = pendingUiRequired.filter(
      (e) => !(OWNER_TODOS as readonly number[]).includes(e.owner),
    );
    expect(unowned.map((e) => `${e.file}::${e.fp} owner=${e.owner}`)).toEqual([]);
  });
});
