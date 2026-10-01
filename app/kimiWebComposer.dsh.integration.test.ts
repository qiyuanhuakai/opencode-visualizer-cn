/**
 * dsh composer preset integration (plan Todo 33, composer half).
 *
 * The composer's dsh preset control branches on the REAL probed write
 * capability (`dshPermissions.selector.writable`), never on a hardcoded flag:
 *
 *   writable   → a preset dropdown over the protocol-native preset names; a
 *               choice writes through `selectDshComposerPreset` and the display
 *               reads back the very state the write landed in.
 *   read-only  → a badge carrying the protocol's own preset string. No writable
 *               dropdown renders and NO mutation request is ever emitted.
 *
 * dsh 0.2.0-rc.2 probed NO preset write endpoint (Todo 6; review blocker #6;
 * Todo 28 evidence), so read-only is the live branch — asserted here against
 * the REAL `createDshPermissions` surface AND at the App.vue seam. The writable
 * branch is proven against a capability-true double that mirrors the real
 * surface's shape (reactive state + computed selector), so the suite fails if
 * the branch ever stops keying on the probed capability.
 *
 * adversarial classes covered: misleading_success_output (zero-mutation
 * assertions at both the seam and the real surface, plus mutation proofs in
 * `.omo/evidence/dsh-web-adapt/task-33.txt`), stale_state (backend switch and
 * expired-bootstrap fencing), malformed_input (unknown preset strings).
 *
 * Structure mirrors `app/kimiWebComposer.integration.test.ts` (source
 * extraction + sandboxed evaluation of the App.vue composer seam).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { computed, reactive, ref } from 'vue';
import {
  createDshPermissions,
  DSH_PERMISSION_PRESET_CATALOG,
  type DshApprovalResponseSurface,
} from './composables/dshPermissions';

const APP_SOURCE = readFileSync(join(process.cwd(), 'app', 'App.vue'), 'utf8');
const APP_SCRIPT_SOURCE = APP_SOURCE.match(/<script lang="ts" setup>([\s\S]*?)<\/script>/)?.[1];

if (!APP_SCRIPT_SOURCE) throw new Error('App.vue script setup block was not found');

const APP_SCRIPT = ts.createSourceFile(
  'App.vue.ts',
  APP_SCRIPT_SOURCE,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function appVariableDeclaration(name: string): string {
  for (const statement of APP_SCRIPT.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
    );
    if (declaration) return `const ${declaration.getText(APP_SCRIPT)};`;
  }
  throw new Error(`App.vue variable ${name} was not found`);
}

function appFunctionDeclaration(name: string): string {
  const declaration = APP_SCRIPT.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`App.vue function ${name} was not found`);
  return declaration.getText(APP_SCRIPT);
}

const PRESET_PROGRAM = ts.transpileModule(
  [
    appVariableDeclaration('dshComposerPresetControl'),
    appFunctionDeclaration('selectDshComposerPreset'),
    '({ control: () => dshComposerPresetControl.value, select: selectDshComposerPreset });',
  ].join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

type PresetControl = { writable: boolean; current: string; options: readonly string[] };

type PresetSeam = {
  control: () => PresetControl | undefined;
  select: (preset: unknown) => boolean;
};

/**
 * Faithful double of the preset surface: a reactive state (the read-back
 * source of truth), a computed selector (the probed capability), and a
 * `selectPreset` that refuses — emitting nothing — unless the capability says
 * writable, exactly like the real composable's contract.
 */
function loadComposerPresetSeam(input: { writable: boolean; current: string; published: boolean }) {
  const state = reactive({
    agentPreset: 'agent-default',
    permissionPreset: input.current,
    sandboxMode: 'workspace',
    approvalPolicy: 'on-request',
  });
  const selectPreset = vi.fn((preset: string) => {
    if (!input.writable) return false;
    state.permissionPreset = preset;
    return true;
  });
  const selector = computed(() => ({
    current: state.permissionPreset,
    options: DSH_PERMISSION_PRESET_CATALOG,
    writable: input.writable,
  }));
  const bridge = ref<unknown>(input.published ? { generation: 1 } : undefined);
  const seam = runInNewContext(PRESET_PROGRAM, {
    computed,
    dshMessageBridge: bridge,
    dshPermissions: { state, selector, selectPreset },
  }) as PresetSeam;
  return {
    seam,
    selectPreset,
    state,
    setPublished: (published: boolean) => {
      bridge.value = published ? { generation: 2 } : undefined;
    },
  };
}

/** The dsh composer branch of the `#after-thinking` slot, verbatim from App.vue. */
function dshComposerBranch(): string {
  const branch = APP_SOURCE.match(
    /<template v-else-if="activeBackendKind === 'dsh'">([\s\S]*?)<\/template>/,
  )?.[1];
  if (!branch) throw new Error('App.vue dsh composer preset branch was not found');
  return branch;
}

function createRealPermissions() {
  return createDshPermissions({
    openPermissionWindow: vi.fn(),
    closePermissionWindow: vi.fn(),
  });
}

describe('dsh composer preset — read-only branch (the live 0.2.0-rc.2 reality)', () => {
  it('the real probed surface is read-only: writable:false, selectPreset refuses, state unchanged', () => {
    const permissions = createRealPermissions();
    permissions.ingestEvent('permission/preset', { preset: 'workspace-write' });
    permissions.ingestEvent('sandbox/mode', { mode: 'workspace' });

    expect(permissions.selector.value.writable).toBe(false);
    expect(permissions.selector.value.options).toEqual([...DSH_PERMISSION_PRESET_CATALOG]);
    expect(permissions.state.permissionPreset).toBe('workspace-write');

    // The write path refuses and NO mutation request exists for it to emit.
    expect(permissions.selectPreset('danger-full-access')).toBe(false);
    expect(permissions.state.permissionPreset).toBe('workspace-write');
  });

  it('the read-only branch emits zero mutation requests against the real bridge surface', () => {
    const resolveApproval = vi.fn();
    const rejectApproval = vi.fn();
    const rejectAllApprovals = vi.fn();
    const permissions = createRealPermissions();
    permissions.attach({
      resolveApproval,
      rejectApproval,
      rejectAllApprovals,
      pendingApprovals: () => [],
      subscribeApprovals: () => () => {},
    } satisfies DshApprovalResponseSurface);

    // A real follow snapshot: the header's agentPreset (a default value only)
    // plus the permissions projection's current preset value.
    permissions.ingestSnapshot({
      header: { id: 'session-1', agentPreset: 'agent-default' },
      projections: {
        values: { agentPreset: 'agent-default', permissions: { currentValue: 'workspace-write' } },
      },
    });
    expect(permissions.state.agentPreset).toBe('agent-default');

    expect(permissions.selectPreset('danger-full-access')).toBe(false);
    expect(permissions.state.permissionPreset).toBe('workspace-write');
    for (const spy of [resolveApproval, rejectApproval, rejectAllApprovals]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('the seam renders the read-only badge and a UI-level choice cannot emit a change request', () => {
    const { seam, selectPreset } = loadComposerPresetSeam({
      writable: false,
      current: 'workspace-write',
      published: true,
    });

    expect(seam.control()).toEqual({
      writable: false,
      current: 'workspace-write',
      options: [...DSH_PERMISSION_PRESET_CATALOG],
    });
    // agentPreset is a default value only — the control surface never exposes it.
    expect(Object.keys(seam.control() ?? {}).sort()).toEqual(['current', 'options', 'writable']);

    expect(seam.select('danger-full-access')).toBe(false);
    expect(selectPreset).not.toHaveBeenCalled();
    expect(seam.control()?.current).toBe('workspace-write');
  });

  it('the template gates the writable dropdown on the probed capability and falls back to the badge', () => {
    const branch = dshComposerBranch();
    expect(branch).toContain('v-if="dshComposerPresetControl.writable"');
    expect(branch).toContain('v-else class="dsh-composer-preset-badge"');
    expect(branch).toContain('{{ dshComposerPresetControl.current }}');
    // The badge carries the protocol's own preset string next to its label.
    expect(branch).toContain("t('statusMonitor.dsh.permissionPreset')");
  });
});

describe('dsh composer preset — writable branch (capability truth)', () => {
  it('a probed write endpoint keeps the dropdown writable with write→read-back consistency', () => {
    const { seam, selectPreset } = loadComposerPresetSeam({
      writable: true,
      current: 'read-only',
      published: true,
    });

    expect(seam.control()).toEqual({
      writable: true,
      current: 'read-only',
      options: [...DSH_PERMISSION_PRESET_CATALOG],
    });

    expect(seam.select('workspace-write')).toBe(true);
    expect(selectPreset).toHaveBeenCalledTimes(1);
    expect(selectPreset).toHaveBeenCalledWith('workspace-write');
    // Read-back: the display reads the very state the write landed in.
    expect(seam.control()?.current).toBe('workspace-write');

    expect(seam.select('danger-full-access')).toBe(true);
    expect(seam.control()?.current).toBe('danger-full-access');
  });

  it('the writable branch renders the protocol-native preset names in the Vis Dropdown', () => {
    const branch = dshComposerBranch();
    expect(branch).toContain('v-for="preset in dshComposerPresetControl.options"');
    expect(branch).toContain('@select="selectDshComposerPreset"');
    // The option label is the protocol's own preset string — no renaming layer.
    expect(branch).toContain('{{ preset }}');
    expect(branch).toMatch(/:active="preset === dshComposerPresetControl\.current"/);
  });

  it('the live dsh probe stays read-only even though the writable branch is wired', () => {
    // The seam proves the branch works when a write endpoint is probed; the real
    // 0.2.0-rc.2 surface proves today's probe found none. Both must hold.
    const permissions = createRealPermissions();
    expect(permissions.selector.value.writable).toBe(false);
    const { seam } = loadComposerPresetSeam({ writable: true, current: 'read-only', published: true });
    expect(seam.control()?.writable).toBe(true);
  });
});

describe('dsh composer preset — stale-state and expired-response fencing', () => {
  it('switching backends leaves no stale dsh preset UI', () => {
    const { seam, state, setPublished } = loadComposerPresetSeam({
      writable: false,
      current: 'workspace-write',
      published: true,
    });
    expect(seam.control()?.current).toBe('workspace-write');

    // Leaving dsh disposes the singleton (App.vue sync activeBackendKind watch):
    // the bridge ref clears, so the composer's control renders nothing.
    setPublished(false);
    expect(seam.control()).toBeUndefined();

    // The previous connection's preset must never resurface on the new one: the
    // new bootstrap ingests its own snapshot before publishing its bridge.
    state.permissionPreset = 'read-only';
    setPublished(true);
    expect(seam.control()?.current).toBe('read-only');
  });

  it('an expired (unpublished) bootstrap response can never surface a preset', () => {
    const { seam, state, setPublished } = loadComposerPresetSeam({
      writable: false,
      current: 'expired-bootstrap-value',
      published: false,
    });
    // The bootstrap was orphaned by a backend switch: it never publishes, so
    // its ingested preset cannot reach the composer even after it lands.
    expect(seam.control()).toBeUndefined();

    // The live connection publishes only after its isCurrent-fenced commit.
    state.permissionPreset = 'danger-full-access';
    setPublished(true);
    expect(seam.control()?.current).toBe('danger-full-access');
  });

  it('App.vue publishes the bridge pair only after the isCurrent fence and disposes on switch', () => {
    const bootstrap = appFunctionDeclaration('bootstrapDshWorkspace');
    expect(bootstrap.lastIndexOf('if (!isCurrent())')).toBeLessThan(
      bootstrap.indexOf('dshMessageBridge.value = bridge'),
    );
    expect(bootstrap).toContain('dshPermissions.attach(bridge)');

    // The sync watch that disposes the singleton when dsh is left behind.
    expect(APP_SOURCE).toMatch(
      /watch\(\s*activeBackendKind[\s\S]*?disconnectDshBackend\(\);/,
    );
  });
});

describe('dsh composer preset — visual discipline and input safety', () => {
  it('renders no native dropdown element and exposes no agentPreset selector', () => {
    const afterThinking = APP_SOURCE.match(
      /<template #after-thinking>([\s\S]*?)<\/template>\s*<\/InputPanel>/,
    )?.[1];
    if (!afterThinking) throw new Error('App.vue after-thinking slot was not found');
    expect(afterThinking).not.toContain('<select');
    expect(afterThinking).not.toContain('<option');

    const branch = dshComposerBranch();
    expect(branch).not.toContain('<select');
    expect(branch).not.toContain('<option');
    // Metis #19: Beta ships no preset-selection UI for agentPreset.
    expect(branch).not.toContain('agentPreset');
  });

  it('the dsh branch sits in the after-thinking chain after codex and kimi-web', () => {
    expect(APP_SOURCE).toMatch(
      /<template #after-thinking>[\s\S]*v-if="activeBackendKind === 'codex'"[\s\S]*v-else-if="activeBackendKind === 'kimi-web'"[\s\S]*v-else-if="activeBackendKind === 'dsh'"[\s\S]*dsh-composer-preset-badge/,
    );
  });

  it('an unknown preset string renders safely and writes never fire', () => {
    const { seam, selectPreset } = loadComposerPresetSeam({
      writable: false,
      current: 'mystery-preset-not-in-catalog',
      published: true,
    });
    expect(seam.control()?.current).toBe('mystery-preset-not-in-catalog');
    expect(seam.control()?.options).toEqual([...DSH_PERMISSION_PRESET_CATALOG]);
    expect(seam.select(42)).toBe(false);
    expect(seam.select(null)).toBe(false);
    expect(seam.select(undefined)).toBe(false);
    expect(seam.select('')).toBe(false);
    expect(selectPreset).not.toHaveBeenCalled();
  });

  it('a malformed preset payload does not crash the real state machine', () => {
    const permissions = createRealPermissions();
    expect(() => permissions.ingestEvent('permission/preset', { preset: 42 })).not.toThrow();
    expect(() => permissions.ingestEvent('permission/preset', null)).not.toThrow();
    expect(permissions.state.permissionPreset).toBe('');
    // A string the catalog does not know still renders verbatim (no crash).
    permissions.ingestEvent('permission/preset', { preset: 'totally-unknown' });
    expect(permissions.state.permissionPreset).toBe('totally-unknown');
  });
});
