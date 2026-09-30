/**
 * Todo 17 — dsh backend-kind branch inventory + enforcement guard.
 *
 * Self-contained mirror of the kimi Todo 12 guard (app/kimiWebBranchGuard.test.ts)
 * for the `'dsh'` backend, but with three deliberate differences:
 *
 *   1. It greps its OWN source-of-truth patterns (no import of the kimi manifest).
 *   2. It detects every backend-kind carrier the dsh adaptation must reason about
 *      — not only `backendKind`-named carriers but also the source/metadata
 *      discriminators (`part.metadata?.source`, `metadata.source`) that dsh parts
 *      branch on, and it adds a literal census of every quoted kind literal
 *      (`'opencode' | 'codex' | 'acp' | 'kimi-web' | 'dsh'`) so a new literal
 *      branch can never slip in unregistered.
 *   3. It adds a `disposition` axis: every entry must be either explicitly
 *      handled, explicitly unsupported / not-applicable, or scheduled under a
 *      named plan todo. A UI-required branch with neither a dsh disposition nor
 *      an owning todo fails the guard — the "禁止静默落入 OpenCode 泛型路径"
 *      requirement encoded as a test.
 *
 * HARD GATE: this todo is a discovery/assertion todo. The dsh branches land in
 * Waves 4-6; those entries carry `disp: 'todo-N'`. The guard turns red if a
 * branch appears that has NEITHER a disposition NOR an owning todo, or if a new
 * branch point is added anywhere in production `app/` without a manifest row.
 *
 * Human-readable inventory: .omo/evidence/dsh-web-adapt/task-17/branch-inventory.md
 * RED-then-GREEN + injection evidence: .omo/evidence/dsh-web-adapt/task-17.txt
 *
 * // allow: SIZE_OK — 222-row pure-data inventory table; the verifier is thin.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_DIR = dirname(fileURLToPath(import.meta.url));

/** Source-of-truth seed patterns (the greps this guard runs at test time). */
const KIND_LITERALS = `(?:opencode|codex|acp|kimi-web|dsh)`;
const OPERAND = `(?:[A-Za-z_$][\\w$]*(?:\\([^()]*\\))?(?:\\.[A-Za-z_$][\\w$]*)*)`;
const CMP_RE = new RegExp(
  `(${OPERAND})\\s*(===|!==)\\s*(['"]${KIND_LITERALS}['"])|(['"]${KIND_LITERALS}['"])\\s*(===|!==)\\s*(${OPERAND})`,
  'g',
);
const CASE_RE = new RegExp(`\\bcase\\s+(['"]${KIND_LITERALS}['"])\\s*:`);
const LITERAL_RE = new RegExp(`['"]${KIND_LITERALS}['"]`, 'g');
const UNION_RE = /backendKind\s*\??:\s*[^;\n]*/;
const ALIAS_RE = /export\s+type\s+BackendKind\s*=/;

/**
 * A backend-kind discriminant must be an actual kind carrier — never a lookalike
 * like an archive `kind`, a message `mode`, or a provider id. Extended beyond the
 * kimi whitelist to include the source/metadata discriminators dsh parts branch
 * on (`metadata?.source`, `part.metadata?.source`, bare `source`).
 */
function isDiscriminant(expr: string): boolean {
  const e = expr.replace(/\s+/g, '');
  if (/backendkind/i.test(e)) return true;
  if (/^(?:[\w$]+\.)*backend$/.test(e)) return true;
  if (/^(?:[\w$]+\.)*source$/.test(e)) return true;
  if (e === 'getActiveBackendKind()') return true;
  if (/^(?:[\w$]+\.)*kind$/.test(e)) return true;
  if (e === 'newKind') return true;
  return false;
}

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

type Kind = 'cmp' | 'case' | 'union' | 'literal';
type Classification = 'ui-required' | 'capability-optional' | 'data-only';
/** An explicit dsh disposition: handled, unsupported, not-applicable, or a plan todo. */
type Disposition = 'handled' | 'unsupported' | 'not-applicable' | `todo-${number}`;

type BranchEntry = {
  /** file path relative to app/ */
  file: string;
  /** stable code-fragment fingerprint (never a bare line number) */
  fp: string;
  /** expected occurrences of this (file, fp, kind) */
  n: number;
  kind: Kind;
  cls: Classification;
  /** explicit dsh disposition record (the "no silent fallback" assertion) */
  disp: Disposition;
  /** plan todo that lands the dsh handling (when still pending) */
  owner?: number;
  /** human context: enclosing surface / symbol */
  sym: string;
};

/**
 * A wiring point the literal-seed greps cannot see (it branches on a
 * backend-specific identifier rather than a quoted kind literal). Its `signal`
 * must remain present in the file, so removing the wiring point turns the guard
 * red just like removing an auto-detected branch.
 */
type ManualEntry = {
  file: string;
  signal: string;
  cls: Classification;
  disp: Disposition;
  owner?: number;
  sym: string;
};

// ---------------------------------------------------------------------------
// INVENTORY (mirrors task-17/branch-inventory.md) — 222 auto-detected rows.
// ---------------------------------------------------------------------------
const BRANCHES: BranchEntry[] = [
  { file: "App.vue", fp: "? 'opencode'", n: 2, kind: 'literal', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "@click=\"loginBackendKind = 'acp'\"", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "@click=\"loginBackendKind = 'codex'\"", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "@click=\"loginBackendKind = 'kimi-web'\"", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "@click=\"loginBackendKind = 'opencode'\"", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "activeBackendKind.value!=='acp'", n: 7, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "activeBackendKind.value!=='codex'", n: 9, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "activeBackendKind.value!=='kimi-web'", n: 13, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "activeBackendKind.value!=='opencode'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "activeBackendKind.value==='acp'", n: 6, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "activeBackendKind.value==='codex'", n: 13, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "activeBackendKind.value==='kimi-web'", n: 16, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "activeBackendKind.value==='opencode'", n: 3, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "activeBackendKind==='acp'", n: 4, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "activeBackendKind==='codex'", n: 6, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "activeBackendKind==='kimi-web'", n: 9, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "backend==='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "backendKind!=='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "case:'acp'", n: 1, kind: 'case', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "case:'codex'", n: 1, kind: 'case', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "case:'kimi-web'", n: 1, kind: 'case', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "case:'opencode'", n: 1, kind: 'case', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "configuredBackendKind==='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "const activeBackendKind = ref<BackendKind>('opencode');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "App.vue", fp: "const loginBackendKind = ref<BackendKind>('opencode');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "loginBackendKind.value!=='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "loginBackendKind.value==='acp'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "loginBackendKind.value==='codex'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "loginBackendKind.value==='kimi-web'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "loginBackendKind==='acp'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "loginBackendKind==='codex'", n: 3, kind: 'cmp', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "loginBackendKind==='kimi-web'", n: 3, kind: 'cmp', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "loginBackendKind==='opencode'", n: 3, kind: 'cmp', cls: 'ui-required', disp: 'todo-32', owner: 32, sym: "login surface" },
  { file: "App.vue", fp: "selectedMode.value = defaultComposerMode('codex', options);", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-33', owner: 33, sym: "active backend / composer / identity" },
  { file: "backends/acp/acpAdapter.ts", fp: "model: { providerID: 'acp', modelID: payload.model ?? 'default' },", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/acpAdapter.ts", fp: "readonly kind = 'acp' as const;", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/bridgeUrl.ts", fp: "export const ACP_PROJECT_ID = 'acp';", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/bridgeUrl.ts", fp: "if (segments.at(-1) === 'codex') segments.pop();", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/configOptions.ts", fp: "connected: ['acp'],", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/configOptions.ts", fp: "id: 'acp',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/configOptions.ts", fp: "providerID: 'acp',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/history.ts", fp: "if (attribution?.modelID) user.info.model = { providerID: 'acp', modelID: attribution.modelID };", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/history.ts", fp: "if (modelValue) next.model = { providerID: 'acp', modelID: modelValue };", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/history.ts", fp: "if (recorded.modelID) next.model = { providerID: 'acp', modelID: recorded.modelID };", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/history.ts", fp: "if (turn.model) next.model = { providerID: 'acp', modelID: turn.model };", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/history.ts", fp: "model: { providerID: 'acp', modelID: currentModelId(state) },", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/acp/history.ts", fp: "providerID: 'acp',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/bridgeUrl.ts", fp: "export const CODEX_PROJECT_ID = 'codex';", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/codexAdapter.ts", fp: "name: 'codex',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/codexAdapter.ts", fp: "readonly kind = 'codex' as const;", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/messageModels.ts", fp: "?? (wireModel?.providerID === 'openai' ? { ...wireModel, providerID: 'codex' } : undefined);", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/messageModels.ts", fp: "const agent = entry.info.role === 'user' || !entry.info.agent || entry.info.agent === 'codex'", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/messageModels.ts", fp: "if (!providerID || !modelID || modelID === 'codex' || modelID === 'unknown') return;", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/messageModels.ts", fp: "return typeof value === 'string' && value.trim() && value.trim() !== 'codex' ? value.trim() : undefined;", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/normalize.ts", fp: "agent: 'codex',", n: 2, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/normalize.ts", fp: "metadata: { source: 'codex' },", n: 3, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/normalize.ts", fp: "metadata: { source: 'codex', codexStatus: params.status, ...params.metadata },", n: 2, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/normalize.ts", fp: "mode: 'codex',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/normalize.ts", fp: "modelID: params.model?.modelID || 'codex',", n: 2, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/codex/normalize.ts", fp: "providerID: params.model?.providerID || 'codex',", n: 2, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/dsh/dshAdapter.ts", fp: "readonly kind = 'dsh' as const;", n: 1, kind: 'literal', cls: 'data-only', disp: 'handled', owner: 15, sym: "dsh adapter internals" },
  { file: "backends/dsh/dshAdapter.ts", fp: "readonly label = 'dsh';", n: 1, kind: 'literal', cls: 'data-only', disp: 'handled', owner: 15, sym: "dsh adapter internals" },
  { file: "backends/dsh/fixtures.ts", fp: "].find((directory) => existsSync(directory)) ?? join(process.cwd(), 'app', 'backends', 'dsh', 'fixtures');", n: 1, kind: 'literal', cls: 'data-only', disp: 'handled', owner: 15, sym: "dsh adapter internals" },
  { file: "backends/dsh/fixtures.ts", fp: "join(process.cwd(), 'app', 'backends', 'dsh', 'fixtures'),", n: 1, kind: 'literal', cls: 'data-only', disp: 'handled', owner: 15, sym: "dsh adapter internals" },
  { file: "backends/dsh/fixtures.ts", fp: "join(process.cwd(), 'backends', 'dsh', 'fixtures'),", n: 1, kind: 'literal', cls: 'data-only', disp: 'handled', owner: 15, sym: "dsh adapter internals" },
  { file: "backends/kimiWeb/handlers-core.ts", fp: "metadata: { source: 'kimi-web' }, time: { start, end: time },", n: 2, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/kimiWeb/handlers-core.ts", fp: "metadata: { source: 'kimi-web', ...(description ? { title: description } : {}) },", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/kimiWeb/handlers-core.ts", fp: "metadata: { source: 'kimi-web', output: text ? (update.replace === true ? text : previous + text) : previous, kimiProgress: update },", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/kimiWeb/handlers-core.ts", fp: "tool: 'other', state: { status: 'pending', input, raw: '' }, metadata: { source: 'kimi-web' },", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/kimiWeb/handlers-events.ts", fp: "...part.metadata, sessionIds, source: 'kimi-web',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/kimiWeb/historyEntries.ts", fp: "? { status: 'completed', input, output, title: frame.name, metadata: { source: 'kimi-web' }, time }", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/kimiWeb/historyEntries.ts", fp: "metadata: { source: 'kimi-web' },", n: 6, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/kimiWeb/historyEntries.ts", fp: "tool: resolveKimiWebToolName(frame.name), state, metadata: { source: 'kimi-web' } });", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/kimiWeb/kimiWebAdapter.ts", fp: "readonly kind = 'kimi-web' as const;", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/kimiWeb/parts.ts", fp: "metadata: { source: 'kimi-web' },", n: 2, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/openCodeAdapter.ts", fp: "kind: 'opencode',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "backend internals" },
  { file: "backends/registry.ts", fp: "'kimi-web': undefined,", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 12, sym: "adapter registry seam" },
  { file: "backends/registry.ts", fp: "adapters = { ...adapters, 'kimi-web': kimiWebAdapter };", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 12, sym: "adapter registry seam" },
  { file: "backends/registry.ts", fp: "getBackendAdapter('opencode').configure?.(options);", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 12, sym: "adapter registry seam" },
  { file: "backends/registry.ts", fp: "let activeBackendKind: BackendKind = 'opencode';", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 12, sym: "adapter registry seam" },
  { file: "backends/registry.ts", fp: "storageGet(StorageKeys.auth.backendKind)!=='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 12, sym: "adapter registry seam" },
  { file: "backends/registry.ts", fp: "storageGet(StorageKeys.auth.backendKind)==='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 12, sym: "adapter registry seam" },
  { file: "backends/types.ts", fp: "BackendKind_alias", n: 1, kind: 'union', cls: 'ui-required', disp: 'handled', owner: 12, sym: "BackendKind contract" },
  { file: "backends/types.ts", fp: "export type BackendKind = 'opencode' | 'codex' | 'acp' | 'kimi-web' | 'dsh';", n: 5, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 12, sym: "BackendKind contract" },
  { file: "components/historyTestBuilders.ts", fp: "mode: 'codex',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "test fixture builder" },
  { file: "components/historyTestBuilders.ts", fp: "modelID: 'codex',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "test fixture builder" },
  { file: "components/historyTestBuilders.ts", fp: "providerID: 'codex',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "test fixture builder" },
  { file: "components/OutputPanel.vue", fp: "backendKind==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "checkpoint action readiness" },
  { file: "components/ProjectPicker.vue", fp: "getActiveBackendKind()==='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "directory browse + .git detection" },
  { file: "components/ProjectPicker.vue", fp: "getActiveBackendKind()==='kimi-web'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "directory browse + .git detection" },
  { file: "components/ProviderManagerModal.vue", fp: "active.kind==='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "provider management (dsh unsupported)" },
  { file: "components/ProviderManagerModal.vue", fp: "active.kind==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "provider management (dsh unsupported)" },
  { file: "components/ProviderManagerModal.vue", fp: "const isCodexBackend = backend().kind === 'codex';", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "provider management (dsh unsupported)" },
  { file: "components/ProviderManagerModal.vue", fp: "if (backend().kind === 'codex') {", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "provider management (dsh unsupported)" },
  { file: "components/ProviderManagerModal.vue", fp: "props.backendKind!=='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "provider management (dsh unsupported)" },
  { file: "components/ProviderManagerModal.vue", fp: "props.backendKind==='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "provider management (dsh unsupported)" },
  { file: "components/ProviderManagerModal.vue", fp: "props.backendKind==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "provider management (dsh unsupported)" },
  { file: "components/StatusMonitorModal.vue", fp: "<div v-if=\"activeTab === 'acp'\" class=\"status-monitor-content\">", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "<div v-if=\"errorMessage && activeTab !== 'acp'\" class=\"status-monitor-feedback is-error\">", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "activeBackendKind==='codex'", n: 4, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "activeBackendKind==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "activeBackendKind==='opencode'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "backendKind: 'kimi-web',", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "base.push({ id: 'acp', labelKey: 'statusMonitor.tabs.acp' });", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "case:'acp'", n: 1, kind: 'case', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "if (activeTab.value === 'acp') {", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "newKind!=='opencode'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "props.activeBackendKind!=='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "props.activeBackendKind!=='opencode'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "props.activeBackendKind==='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "props.activeBackendKind==='codex'", n: 4, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "props.activeBackendKind==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "props.activeBackendKind==='opencode'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/StatusMonitorModal.vue", fp: "type TabId = 'server' | 'mcp' | 'lsp' | 'plugins' | 'skills' | 'token' | 'mc' | 'acp';", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-34', owner: 34, sym: "status monitor sections" },
  { file: "components/ThreadBlock.vue", fp: "backendKind!=='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "message card actions/diff gates" },
  { file: "components/ThreadBlock.vue", fp: "props.backendKind!=='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "message card actions/diff gates" },
  { file: "components/ThreadBlock.vue", fp: "props.backendKind==='acp'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "message card actions/diff gates" },
  { file: "components/ThreadBlock.vue", fp: "props.backendKind==='codex'", n: 3, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "message card actions/diff gates" },
  { file: "components/ThreadBlock.vue", fp: "props.backendKind==='kimi-web'", n: 12, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "message card actions/diff gates" },
  { file: "composables/backendMessageSend.kimiSlash.ts", fp: "params.activeBackendKind.value==='kimi-web'", n: 1, kind: 'cmp', cls: 'capability-optional', disp: 'handled', owner: 18, sym: "kimi slash dispatch (dsh has none)" },
  { file: "composables/backendMessageSend.openCode.ts", fp: "preflight.backend==='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-25', owner: 25, sym: "opencode send fail-closed seam" },
  { file: "composables/backendMessageSend.openCode.ts", fp: "preflight.backend==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-25', owner: 25, sym: "opencode send fail-closed seam" },
  { file: "composables/backendMessageSend.preflight.ts", fp: "backend!=='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "preflight model gating" },
  { file: "composables/backendMessageSend.preflight.ts", fp: "backend!=='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "preflight model gating" },
  { file: "composables/backendMessageSend.preflight.ts", fp: "backend==='codex'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "preflight model gating" },
  { file: "composables/backendMessageSend.preflight.ts", fp: "backend==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "preflight model gating" },
  { file: "composables/backendMessageSend.slash.ts", fp: "params.activeBackendKind.value!=='codex'", n: 1, kind: 'cmp', cls: 'capability-optional', disp: 'handled', owner: 18, sym: "codex slash dispatch (dsh has none)" },
  { file: "composables/backendMessageSend.slash.ts", fp: "params.activeBackendKind.value==='codex'", n: 1, kind: 'cmp', cls: 'capability-optional', disp: 'handled', owner: 18, sym: "codex slash dispatch (dsh has none)" },
  { file: "composables/useAcpMessageBridge.ts", fp: "backendKind==='acp'", n: 1, kind: 'cmp', cls: 'capability-optional', disp: 'handled', sym: "acp-only gate (excludes dsh)" },
  { file: "composables/useAcpTerminalAction.ts", fp: "options.activeBackendKind.value!=='acp'", n: 1, kind: 'cmp', cls: 'capability-optional', disp: 'handled', sym: "acp-only gate (excludes dsh)" },
  { file: "composables/useBackendActivation.ts", fp: "options.activeBackendKind.value = 'acp';", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.activeBackendKind.value = 'codex';", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.activeBackendKind.value = 'dsh';", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.activeBackendKind.value = 'kimi-web';", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.activeBackendKind.value = 'opencode';", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.credentials.backendKind.value==='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.credentials.backendKind.value==='codex'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.credentials.backendKind.value==='dsh'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.credentials.backendKind.value==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.setActiveBackendKind('acp');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.setActiveBackendKind('codex');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.setActiveBackendKind('dsh');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.setActiveBackendKind('kimi-web');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendActivation.ts", fp: "options.setActiveBackendKind('opencode');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 14, sym: "activation dispatch" },
  { file: "composables/useBackendMessageSend.ts", fp: "params.activeBackendKind.value==='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-25', owner: 25, sym: "message send dispatch" },
  { file: "composables/useBackendMessageSend.ts", fp: "params.activeBackendKind.value==='kimi-web'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-25', owner: 25, sym: "message send dispatch" },
  { file: "composables/useBackendMessageSend.ts", fp: "preflight.backend==='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-25', owner: 25, sym: "message send dispatch" },
  { file: "composables/useBackendMessageSend.ts", fp: "preflight.backend==='kimi-web'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-25', owner: 25, sym: "message send dispatch" },
  { file: "composables/useBackendSelectionBootstrap.ts", fp: "params.activeBackendKind.value==='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "selection bootstrap" },
  { file: "composables/useBackendSelectionBootstrap.ts", fp: "params.activeBackendKind.value==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "selection bootstrap" },
  { file: "composables/useBackendSessionActions.ts", fp: "backendKind==='acp'", n: 4, kind: 'cmp', cls: 'ui-required', disp: 'todo-27', owner: 27, sym: "session actions" },
  { file: "composables/useBackendSessionActions.ts", fp: "backendKind==='codex'", n: 4, kind: 'cmp', cls: 'ui-required', disp: 'todo-27', owner: 27, sym: "session actions" },
  { file: "composables/useBackendSessionActions.ts", fp: "backendKind==='kimi-web'", n: 4, kind: 'cmp', cls: 'ui-required', disp: 'todo-27', owner: 27, sym: "session actions" },
  { file: "composables/useBackendSessionActions.ts", fp: "const ownsRequest = () => requestBackend !== 'kimi-web' ||", n: 2, kind: 'literal', cls: 'ui-required', disp: 'todo-27', owner: 27, sym: "session actions" },
  { file: "composables/useBackendSessionActions.ts", fp: "params.activeBackendKind.value!=='kimi-web'", n: 3, kind: 'cmp', cls: 'ui-required', disp: 'todo-27', owner: 27, sym: "session actions" },
  { file: "composables/useBackendSessionActions.ts", fp: "params.activeBackendKind.value!=='opencode'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-27', owner: 27, sym: "session actions" },
  { file: "composables/useBackendSessionActions.ts", fp: "params.activeBackendKind.value==='codex'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-27', owner: 27, sym: "session actions" },
  { file: "composables/useBackendSessionActions.ts", fp: "params.activeBackendKind.value==='kimi-web'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-27', owner: 27, sym: "session actions" },
  { file: "composables/useBackendSessionLifecycle.ts", fp: "case:'acp'", n: 1, kind: 'case', cls: 'ui-required', disp: 'todo-22', owner: 22, sym: "session create/open/abort routing" },
  { file: "composables/useBackendSessionLifecycle.ts", fp: "case:'codex'", n: 1, kind: 'case', cls: 'ui-required', disp: 'todo-22', owner: 22, sym: "session create/open/abort routing" },
  { file: "composables/useBackendSessionLifecycle.ts", fp: "case:'dsh'", n: 1, kind: 'case', cls: 'ui-required', disp: 'handled', owner: 22, sym: "session create/open/abort routing" },
  { file: "composables/useBackendSessionLifecycle.ts", fp: "case:'kimi-web'", n: 1, kind: 'case', cls: 'ui-required', disp: 'todo-22', owner: 22, sym: "session create/open/abort routing" },
  { file: "composables/useBackendSessionLifecycle.ts", fp: "case:'opencode'", n: 1, kind: 'case', cls: 'ui-required', disp: 'todo-22', owner: 22, sym: "session create/open/abort routing" },
  { file: "composables/useBackendSessionLifecycle.ts", fp: "params.activeBackendKind.value==='acp'", n: 4, kind: 'cmp', cls: 'ui-required', disp: 'todo-22', owner: 22, sym: "session create/open/abort routing" },
  { file: "composables/useBackendSessionLifecycle.ts", fp: "params.activeBackendKind.value==='codex'", n: 4, kind: 'cmp', cls: 'ui-required', disp: 'todo-22', owner: 22, sym: "session create/open/abort routing" },
  { file: "composables/useBackendSessionLifecycle.ts", fp: "params.activeBackendKind.value==='dsh'", n: 4, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 22, sym: "session create/open/abort routing" },
  { file: "composables/useBackendSessionLifecycle.ts", fp: "params.activeBackendKind.value!=='dsh'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 22, sym: "shared-transport event subscription backend fence" },
  { file: "composables/useBackendSessionLifecycle.ts", fp: "params.activeBackendKind.value==='kimi-web'", n: 5, kind: 'cmp', cls: 'ui-required', disp: 'todo-22', owner: 22, sym: "session create/open/abort routing" },
  { file: "composables/useBackendSessionReload.ts", fp: "params.activeBackendKind.value==='codex'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-26', owner: 26, sym: "history reload branching" },
  { file: "composables/useBackendSessionReload.ts", fp: "params.activeBackendKind.value==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-26', owner: 26, sym: "history reload branching" },
  { file: "composables/useBackendSessionReload.ts", fp: "previousCacheContext.backend!=='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-26', owner: 26, sym: "history reload branching" },
  { file: "composables/useBackendSessionStatus.ts", fp: "params.activeBackendKind.value==='codex'", n: 1, kind: 'cmp', cls: 'capability-optional', disp: 'todo-22', owner: 22, sym: "turn status semantics" },
  { file: "composables/useBackendSessionTrees.ts", fp: "const project = params.projects[params.codexProjectId ?? 'codex'];", n: 1, kind: 'literal', cls: 'ui-required', disp: 'todo-21', owner: 21, sym: "session tree routing" },
  { file: "composables/useBackendSessionTrees.ts", fp: "params.activeBackendKind.value==='acp'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-21', owner: 21, sym: "session tree routing" },
  { file: "composables/useBackendSessionTrees.ts", fp: "params.activeBackendKind.value==='codex'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-21', owner: 21, sym: "session tree routing" },
  { file: "composables/useBackendSessionTrees.ts", fp: "params.activeBackendKind.value==='kimi-web'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'todo-21', owner: 21, sym: "session tree routing" },
  { file: "composables/useBackendSessionTrees.ts", fp: "params.activeBackendKind.value==='dsh'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 21, sym: "session tree routing" },
  { file: "composables/useCodexApi.ts", fp: "agent: parent?.info.role === 'user' ? parent.info.agent : 'codex',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "codex API internals" },
  { file: "composables/useCodexApi.ts", fp: "configuredProvider !== 'openai' && configuredProvider !== 'codex') {", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "codex API internals" },
  { file: "composables/useCodexApi.ts", fp: "const fallbackMetadata = { source: 'codex' };", n: 2, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "codex API internals" },
  { file: "composables/useCodexApi.ts", fp: "const providerID = normalized.slice(0, slashIndex).trim() || 'codex';", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "codex API internals" },
  { file: "composables/useCodexApi.ts", fp: "if (!normalized) return { providerID: 'codex', modelID: '' };", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "codex API internals" },
  { file: "composables/useCodexApi.ts", fp: "mode: 'codex',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "codex API internals" },
  { file: "composables/useCodexApi.ts", fp: "modelID: parent?.info.role === 'user' ? parent.info.model.modelID : model.modelID || 'codex',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "codex API internals" },
  { file: "composables/useCodexApi.ts", fp: "return { providerID: 'codex', modelID: normalized };", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "codex API internals" },
  { file: "composables/useCodexMessageBridge.ts", fp: "params.activeBackendKind.value!=='codex'", n: 10, kind: 'cmp', cls: 'capability-optional', disp: 'handled', sym: "codex-only gate (excludes dsh)" },
  { file: "composables/useCodexWorkspaceSync.ts", fp: "backendKind!=='codex'", n: 1, kind: 'cmp', cls: 'capability-optional', disp: 'handled', sym: "codex-only gate (excludes dsh)" },
  { file: "composables/useCredentials.ts", fp: ": 'opencode';", n: 2, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "backendKind.value==='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "backendKind.value==='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "backendKind.value==='dsh'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "backendKind.value==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "const backendKind = ref<BackendKind>('opencode');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "event.newValue === 'acp' ||", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "event.newValue === 'codex' ||", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "event.newValue === 'dsh'", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "event.newValue === 'kimi-web' ||", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "preservedBackendKind==='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "preservedBackendKind==='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "preservedBackendKind==='dsh'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "preservedBackendKind==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "saveBackendKind('acp');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "saveBackendKind('codex');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "saveBackendKind('dsh');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "saveBackendKind('kimi-web');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "saveBackendKind('opencode');", n: 1, kind: 'literal', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "storedBackendKind==='acp'", n: 2, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "storedBackendKind==='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "storedBackendKind==='dsh'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useCredentials.ts", fp: "storedBackendKind==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'handled', owner: 13, sym: "credentials four-branch" },
  { file: "composables/useDesktopBridgeVersion.ts", fp: "target.backendKind==='acp'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "desktop bridge version probe" },
  { file: "composables/useDesktopBridgeVersion.ts", fp: "target.backendKind==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "desktop bridge version probe" },
  { file: "composables/useFileTree.ts", fp: "backendKind==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-30', owner: 30, sym: "file tree status source" },
  { file: "composables/useLiveDescendantHistoryHydration.ts", fp: "backendKind==='opencode'", n: 1, kind: 'cmp', cls: 'capability-optional', disp: 'handled', sym: "opencode-only scope (excludes dsh)" },
  { file: "composables/useRootHistoryLoader.ts", fp: "options.activeBackendKind.value==='acp'", n: 1, kind: 'cmp', cls: 'capability-optional', disp: 'handled', sym: "acp-only metadata refresh" },
  { file: "composables/useSubagentWindows.ts", fp: "agentLabel = messageInfo.mode === 'codex' ? messageInfo.agent", n: 1, kind: 'literal', cls: 'capability-optional', disp: 'todo-24', owner: 24, sym: "subagent window message-mode" },
  { file: "utils/codexTopPanelTree.ts", fp: "const keyPrefix = options.keyPrefix ?? 'codex';", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "codex tree internals" },
  { file: "utils/defaultComposerMode.ts", fp: "backend==='codex'", n: 1, kind: 'cmp', cls: 'capability-optional', disp: 'todo-33', owner: 33, sym: "composer default mode" },
  { file: "utils/historyEntries.fixtures.ts", fp: "mode: 'codex',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "test fixtures" },
  { file: "utils/historyEntries.fixtures.ts", fp: "modelID: 'codex',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "test fixtures" },
  { file: "utils/historyEntries.fixtures.ts", fp: "providerID: 'codex',", n: 1, kind: 'literal', cls: 'data-only', disp: 'not-applicable', sym: "test fixtures" },
  { file: "utils/historyEntries.ts", fp: "source!=='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "history entry source mapping" },
  { file: "utils/threadSubagents.ts", fp: "source!=='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "subagent thread source mapping" },
  { file: "utils/threadSubagents.ts", fp: "source!=='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "subagent thread source mapping" },
  { file: "utils/threadSubagents.ts", fp: "source==='codex'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "subagent thread source mapping" },
  { file: "utils/threadSubagents.ts", fp: "source==='kimi-web'", n: 1, kind: 'cmp', cls: 'ui-required', disp: 'todo-35', owner: 35, sym: "subagent thread source mapping" },
];

const MANUAL: ManualEntry[] = [
  {
    file: 'composables/useMessageCacheAuthInvalidation.ts',
    signal: 'kimiWebBridgeToken',
    cls: 'ui-required',
    disp: 'todo-35',
    owner: 35,
    sym: 'auth-token watch list must gain dshBridgeToken so a dsh login invalidates the message cache',
  },
  {
    file: 'composables/backendMessageSend.types.ts',
    signal: 'kimiWebApi?: KimiWebSendApi',
    cls: 'ui-required',
    disp: 'todo-25',
    owner: 25,
    sym: 'optional backend api seam; dsh must add a dshApi param and fail closed instead of using OpenCode',
  },
  ...[
    'locales/en.ts',
    'locales/zh-CN.ts',
    'locales/zh-TW.ts',
    'locales/ja.ts',
    'locales/eo.ts',
    'i18n/types.ts',
  ].map((file) => ({
    file,
    signal: 'kimiWebTitle',
    cls: 'data-only' as const,
    disp: 'todo-32' as const,
    owner: 32,
    sym: 'login surface needs dsh* keys mirroring the kimiWebTitle/kimiWebBridge* block (5 languages + type)',
  })),
];

// ---------------------------------------------------------------------------
// Detection (must mirror the seed greps exactly)
// ---------------------------------------------------------------------------
type Detected = { key: string; file: string; fp: string; kind: Kind; n: number };

function keyOf(file: string, kind: Kind, fp: string): string {
  return `${file}\u0000${kind}\u0000${fp}`;
}

function detectEntries(file: string, content: string): Map<string, Detected> {
  const found = new Map<string, Detected>();
  const push = (kind: Kind, fp: string, amount = 1) => {
    const key = keyOf(file, kind, fp);
    const prev = found.get(key);
    if (prev) prev.n += amount;
    else found.set(key, { key, file, fp, kind, n: amount });
  };
  content.split('\n').forEach((text) => {
    let hasCmp = false;
    for (const m of text.matchAll(CMP_RE)) {
      const expr = m[1] || m[6];
      const op = m[2] || m[5];
      const lit = m[3] || m[4];
      if (!expr || !op || !lit) continue;
      if (!isDiscriminant(expr)) continue;
      hasCmp = true;
      push('cmp', `${expr.replace(/\s+/g, '')}${op}${lit.replace(/"/g, "'")}`);
    }
    const caseMatch = text.match(CASE_RE);
    if (caseMatch) push('case', `case:${caseMatch[1].replace(/"/g, "'")}`);
    if (ALIAS_RE.test(text) && /'opencode'/.test(text)) {
      push('union', 'BackendKind_alias');
    } else if (UNION_RE.test(text) && /'opencode'/.test(text)) {
      const fp = (text.match(UNION_RE)?.[0] ?? text).replace(/\s+/g, '').replace(/[;,]\s*$/, '');
      push('union', fp);
    }
    if (!hasCmp && !caseMatch) {
      const lits = [...text.matchAll(LITERAL_RE)];
      if (lits.length) push('literal', text.trim().replace(/\s+/g, ' '), lits.length);
    }
  });
  return found;
}

const fileContents = new Map(
  walkProductionFiles(APP_DIR).map((f) => [f, readFileSync(join(APP_DIR, f), 'utf8')]),
);

const live = new Map<string, Detected>();
for (const [file, content] of fileContents) {
  for (const [key, entry] of detectEntries(file, content)) live.set(key, entry);
}

const expected = new Map<string, BranchEntry>();
for (const e of BRANCHES) {
  const key = keyOf(e.file, e.kind, e.fp);
  const prev = expected.get(key);
  if (prev) prev.n += e.n;
  else expected.set(key, { ...e });
}

const unknownBranches: string[] = [];
for (const [key, d] of live) {
  if (!expected.has(key)) unknownBranches.push(`${d.file} → [${d.kind}] ${d.fp} (x${d.n})`);
}

const drift: string[] = [];
for (const [key, e] of expected) {
  const actual = live.get(key);
  if (!actual) drift.push(`${e.file} → [${e.kind}] ${e.fp} (missing; expected x${e.n})`);
  else if (actual.n !== e.n) drift.push(`${e.file} → [${e.kind}] ${e.fp} expected x${e.n}, found x${actual.n}`);
}

const validDispositions = new Set<string>(['handled', 'unsupported', 'not-applicable']);
const isTodoDisp = (d: string) => /^todo-\d+$/.test(d);

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------
describe('dsh backend-kind branch guard (Todo 17)', () => {
  it('every inventoried branch site still exists at its recorded multiplicity', () => {
    expect(drift).toEqual([]);
  });

  it('fails when a branch point appears that is not in the inventory', () => {
    expect(unknownBranches).toEqual([]);
  });

  it('every entry carries a dsh disposition or an owning plan todo (no silent fallback)', () => {
    const offenders = BRANCHES.filter(
      (e) =>
        !validDispositions.has(e.disp) &&
        !isTodoDisp(e.disp) &&
        !MANUAL.some((m) => m.file === e.file && m.disp === e.disp && m.owner),
    );
    expect(offenders.map((e) => `${e.file} → [${e.kind}] ${e.fp} disp=${e.disp}`)).toEqual([]);
  });

  it('every UI-required branch is explicitly handled, explicitly unsupported, or scheduled', () => {
    // A ui-required branch must never silently fall through to the OpenCode
    // generic path: it is either explicitly handled, explicitly unsupported, or
    // carries a plan todo whose number matches its owner.
    const bad = BRANCHES.filter(
      (e) =>
        e.cls === 'ui-required' &&
        !(
          e.disp === 'handled' ||
          e.disp === 'unsupported' ||
          (isTodoDisp(e.disp) && e.owner === Number(e.disp.slice(5)))
        ),
    );
    expect(bad.map((e) => `${e.file} → ${e.fp} disp=${e.disp} owner=${e.owner}`)).toEqual([]);
  });

  it('every pending (todo-N) entry is owned by a real plan todo number', () => {
    const planned = new Set(
      BRANCHES.filter((e) => isTodoDisp(e.disp)).map((e) => Number(e.disp.slice(5))),
    );
    const owners = BRANCHES.filter((e) => isTodoDisp(e.disp)).map((e) => e.owner);
    expect(owners.every((o) => typeof o === 'number' && planned.has(o))).toBe(true);
  });

  it('every manual wiring point still exists (removal turns the guard red)', () => {
    const missing = MANUAL.filter(
      (m) => !(fileContents.get(m.file) ?? '').includes(m.signal),
    );
    expect(missing.map((m) => `${m.file} missing /${m.signal}/`)).toEqual([]);
  });

  it('the registry registers dsh without an OpenCode fallback at the adapter seam', () => {
    const registry = fileContents.get('backends/registry.ts') ?? '';
    for (const signal of ["adapters = { ...adapters, dsh: dshAdapter }", 'configureDshBackend', 'disconnectDshBackend']) {
      expect(registry).toContain(signal);
    }
  });

  it('BackendKind contract includes dsh', () => {
    const types = fileContents.get('backends/types.ts') ?? '';
    expect(types).toMatch(/export type BackendKind =[^;]*'dsh'/);
  });

  it('EFFICACY: a newly added branch not in the inventory is flagged (not snapshot-only)', () => {
    // Feed the *same* detection used against production files a synthetic source
    // with a brand-new branch; the guard must classify it as unregistered.
    const synthetic = [
      'export function injectedProbe(activeBackendKind: { value: string }): boolean {',
      "  return activeBackendKind.value === 'dsh';",
      '}',
      '',
    ].join('\n');
    const detected = [...detectEntries('__synthetic_injection__.ts', synthetic).values()];
    const flagged = detected.filter((d) => !expected.has(d.key));
    expect(flagged.map((d) => `${d.file} → [${d.kind}] ${d.fp}`)).toEqual([
      "__synthetic_injection__.ts → [cmp] activeBackendKind.value==='dsh'",
    ]);
  });
});
