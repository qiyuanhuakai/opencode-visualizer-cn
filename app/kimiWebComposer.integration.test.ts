import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { useKimiWebSessionModes } from './composables/useKimiWebSessionModes';
import { kimiWebAgentModeOptions } from './utils/kimiWebModeOptions';

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

const AGENT_PICKER_PROGRAM = ts.transpileModule(
  [
    appVariableDeclaration('hasAgentOptions'),
    appVariableDeclaration('agentPickerState'),
    'agentPickerState.value;',
  ].join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

type AgentPickerState = 'loading' | 'unsupported' | 'ready';

function appAgentPickerState(input: {
  backendKind: string;
  agentOptions?: Array<{ id: string }>;
  kimiWebAgentOptions?: Array<{ id: string }>;
  agentsLoading: boolean;
}): AgentPickerState {
  const result: unknown = runInNewContext(AGENT_PICKER_PROGRAM, {
    computed,
    activeBackendKind: ref(input.backendKind),
    agentOptions: ref(input.agentOptions ?? []),
    kimiWebAgentOptions: ref(input.kimiWebAgentOptions ?? []),
    agentsLoading: ref(input.agentsLoading),
  });
  if (result === 'loading' || result === 'unsupported' || result === 'ready') return result;
  throw new Error(`Unexpected App.vue agent picker state: ${String(result)}`);
}

function createController(meta: unknown = { experimental_flags: { tower: false } }) {
  const writeMode = vi.fn().mockResolvedValue(undefined);
  const controller = useKimiWebSessionModes({
    writeMode,
    loadMeta: vi.fn().mockResolvedValue(meta),
  });
  return { controller, writeMode };
}

describe('kimi-web composer integration', () => {
  it('kimi mounts ready permission options and switches after thinking', () => {
    expect(APP_SOURCE).toContain('kimiWebAgentModeOptions()');
    expect(APP_SOURCE).toMatch(
      /activeBackendKind === 'kimi-web'\s*\? kimiWebAgentOptions\s*:\s*agentOptions/,
    );
    expect(APP_SOURCE).toMatch(
      /<template #after-thinking>[\s\S]*v-if="activeBackendKind === 'codex'"[\s\S]*<KimiWebComposerModes[\s\S]*v-else-if="activeBackendKind === 'kimi-web'"/,
    );
    expect(APP_SOURCE).toMatch(/kimiWebAgentOptions\.value\.length > 0/);
    expect(APP_SOURCE).not.toContain('kimiWebAgentOptions.value.length === 3');
    expect(APP_SOURCE).not.toMatch(
      /activeBackendKind\.value === 'kimi-web'\) return '(?:unsupported|loading)'/,
    );
  });

  it('changing kimi permission preserves model and thinking', async () => {
    const model = ref('kimi-code/k3');
    const thinking = ref<string | undefined>('high');
    const { controller, writeMode } = createController();

    await controller.changeMode('session-a', { field: 'permissionMode', value: 'auto' });

    expect(model.value).toBe('kimi-code/k3');
    expect(thinking.value).toBe('high');
    expect(writeMode).toHaveBeenCalledTimes(1);
    expect(writeMode).toHaveBeenCalledWith('session-a', {
      field: 'permissionMode',
      value: 'auto',
    });
    expect(APP_SOURCE).toMatch(
      /activeBackendKind\.value === 'kimi-web'[\s\S]*changeKimiWebMode\(\{ field: 'permissionMode', value \}\)/,
    );
    expect(APP_SOURCE).toMatch(
      /if \(activeBackendKind\.value === 'kimi-web'\) \{[\s\S]*changeKimiWebMode[\s\S]*return;[\s\S]*if \(activeBackendKind\.value !== 'codex'\) applyAgentDefaults/,
    );
  });

  it('restoring a kimi draft does not restore permission or apply agent defaults', () => {
    expect(APP_SOURCE).toMatch(
      /function applyComposerDraftToComposerState[\s\S]*activeBackendKind\.value === 'kimi-web'[\s\S]*applyModelVariantSelection/,
    );
    expect(APP_SOURCE).toMatch(
      /agent:\s*activeBackendKind\.value === 'kimi-web'\s*\? ''\s*:\s*selectedMode\.value/,
    );
  });

  it('switching sessions never displays the previous sessions optimistic mode', async () => {
    const { controller } = createController();
    const pending = controller.changeMode('session-a', { field: 'permissionMode', value: 'yolo' });
    expect(controller.sessionState('session-a').permissionMode).toBe('yolo');

    controller.resetSession('session-b');

    expect(controller.sessionState('session-b')).toEqual({ confidence: 'unknown' });
    await pending;
    expect(APP_SOURCE).toMatch(
      /watch\(selectedSessionId,[\s\S]*kimiWebSessionModes\.resetSession\(nextId\)/,
    );
  });

  it('codex retains Fast and Goal and other backends retain their pickers', () => {
    expect(APP_SOURCE).toMatch(
      /v-if="activeBackendKind === 'codex'"[\s\S]*<CodexComposerFast[\s\S]*<CodexComposerGoal/,
    );
    expect(APP_SOURCE).toMatch(
      /activeBackendKind === 'codex'\s*\? codexAgentOptions\s*:\s*activeBackendKind === 'kimi-web'/,
    );
    expect(APP_SOURCE).toContain(':agent-picker-state="agentPickerState"');
  });

  it('tower switch is disabled without the experimental flag and enabled with it', async () => {
    const disabled = createController({ experimental_flags: { tower: false } });
    await expect(
      disabled.controller.changeMode('session-a', { field: 'towerMode', value: true }),
    ).rejects.toThrow('Tower mode is not enabled');
    expect(disabled.controller.towerEnabled).toBe(false);

    const enabled = createController({ experimental_flags: { tower: true } });
    await enabled.controller.changeMode('session-a', { field: 'towerMode', value: true });
    expect(enabled.controller.towerEnabled).toBe(true);
    expect(APP_SOURCE).toContain(':tower-enabled="kimiWebTowerEnabled"');
  });
});

describe('App.vue agent picker state machine', () => {
  it('kimi-web agent picker resolves ready with its three permission modes', () => {
    const options = kimiWebAgentModeOptions().map(({ id }) => ({ id }));

    expect(options.map(({ id }) => id)).toEqual(['manual', 'auto', 'yolo']);
    expect(
      appAgentPickerState({
        backendKind: 'kimi-web',
        kimiWebAgentOptions: options,
        agentsLoading: false,
      }),
    ).toBe('ready');
  });

  it('a backend without agent options resolves unsupported rather than loading forever', () => {
    expect(
      appAgentPickerState({
        backendKind: 'acp',
        agentOptions: [],
        agentsLoading: false,
      }),
    ).toBe('unsupported');
  });

  it('a still-loading backend resolves loading', () => {
    expect(
      appAgentPickerState({
        backendKind: 'opencode',
        agentOptions: [],
        agentsLoading: true,
      }),
    ).toBe('loading');
  });
});
