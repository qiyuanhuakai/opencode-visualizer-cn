/**
 * Todo 35 — dsh shared-surface absence (渲染缺口收口).
 *
 * The dsh adaptation must NOT invent entry points for capabilities dsh does not
 * have. This suite renders the shared surfaces with dsh active and asserts that
 * none of the five not-applicable surfaces appear — and that their absence is a
 * quiet absence, never an error state:
 *
 *   1. provider-model 徽标   → the kimi-web provider/model badge block never
 *                              mounts for dsh (ProviderManagerModal, real mount)
 *   2. todos 对接            → the shared todo loader resolves no dsh todos and
 *                              records no error (useTodos, real composable)
 *   3. questions             → the dsh adapter exposes no question surface at
 *                              all, so the shared question dialog can never open
 *   4. web link              → no Vis web-link affordance exists for any backend
 *   5. recents               → no Vis recents surface exists for any backend
 *
 * It complements `backendLoginIsolation.integration.test.ts` (the positive dsh
 * login surface) and `backends/dsh/capabilities.test.ts` (the registry-level
 * negative capability matrix).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import {
  expandProviderList,
  mountProviderManager,
  requireElement,
  setProviderBackend,
} from './components/providerManagerModal.test-helpers';
import { useTodos } from './composables/useTodos';
import { getActiveBackendAdapter } from './backends/registry';
import { DshAdapter, DSH_CAPABILITIES } from './backends/dsh/dshAdapter';
import {
  DSH_EXCLUDED_UI_FEATURES,
  DSH_FALSE_CAPABILITY_ENFORCEMENT,
} from './backends/dsh/capabilities';

const REPO_ROOT = path.resolve(__dirname, '..');

function dshBackendAdapterShim() {
  // Exactly the dsh adapter's public shape: the provider-read methods it really
  // has, and NOTHING the capability matrix reports false. The real-class
  // absence assertions below keep this shim from faking a capability in.
  return {
    kind: 'dsh' as const,
    capabilities: { ...DSH_CAPABILITIES },
    listProviders: vi.fn(async () => ({ providers: [] })),
    getGlobalConfig: vi.fn(async () => ({
      enabled_providers: [] as string[],
      disabled_providers: [] as string[],
    })),
  };
}

describe('dsh surface absence — provider-model 徽标', () => {
  it('renders no kimi provider-model badge block when the active backend is dsh', async () => {
    setProviderBackend(dshBackendAdapterShim());
    const { host, setOpen } = await mountProviderManager({
      backendKind: 'dsh',
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          source: 'env',
          models: { 'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' } },
        },
      ],
      connectedProviderIds: ['deepseek'],
    });
    await setOpen(true);
    await expandProviderList(host);

    expect(host.querySelectorAll('.kimi-web-provider-model').length).toBe(0);
    expect(host.querySelectorAll('.kimi-web-provider-model-badges').length).toBe(0);
    expect(host.querySelectorAll('.kimi-web-provider-model-details').length).toBe(0);

    // dsh exposes no provider-config write surface, so the custom-provider
    // action renders disabled rather than as a working fake entry point.
    const customConnect = requireElement<HTMLButtonElement>(
      host,
      '.custom-provider-entry button',
    );
    expect(customConnect.disabled).toBe(true);
  });
});

describe('dsh surface absence — todos 对接', () => {
  it('resolves no todos and records no error while dsh is active', async () => {
    setProviderBackend(dshBackendAdapterShim());
    const todos = useTodos({
      selectedSessionId: ref('session-a'),
      allowedSessionIds: computed(() => new Set(['session-a'])),
      activeDirectory: ref('/repo'),
    });

    await todos.reloadTodosForAllowedSessions();

    expect(todos.todosBySessionId.value).toEqual({ 'session-a': [] });
    expect(todos.todoErrorBySessionId.value).toEqual({});
    expect(todos.todoLoadingBySessionId.value).toEqual({});
  });

  it('the real dsh adapter class has no todo surface to drive one', () => {
    expect(
      (DshAdapter.prototype as unknown as Record<string, unknown>).getSessionTodos,
    ).toBeUndefined();
  });
});

describe('dsh surface absence — questions', () => {
  it('exposes no question surface, so the shared question dialog can never open', () => {
    setProviderBackend(dshBackendAdapterShim());
    const adapter = getActiveBackendAdapter() as Record<string, unknown>;

    expect(adapter.replyQuestion).toBeUndefined();
    expect(adapter.rejectQuestion).toBeUndefined();

    // The enforcement stays classified no-surface: nothing to hide, nothing to
    // fail-loud at idle — the dsh wire contract simply carries no questions.
    expect(DSH_FALSE_CAPABILITY_ENFORCEMENT.questions.kind).toBe('no-surface');
    expect(
      (DshAdapter.prototype as unknown as Record<string, unknown>).listPendingQuestions,
    ).toBeUndefined();
  });
});

describe('dsh surface absence — web link / recents', () => {
  it('classifies both as features with no Vis entry point at all', () => {
    for (const id of ['web', 'recents']) {
      const feature = DSH_EXCLUDED_UI_FEATURES.find((entry) => entry.id === id);
      if (!feature) throw new Error(`dsh exclusion registry lost the ${id} feature`);
      expect(feature.capability, `${id} must not map onto a dsh capability bit`).toBeNull();
      // Both features word the "no such Vis surface" verdict differently
      // ("No Vis entry point" / 'No Vis "Recents" surface'), so match the prefix.
      expect(feature.note, `${id} must be recorded as having no Vis surface`).toMatch(/^No Vis /);
    }
  });

  it('has no recents or web-link affordance anywhere in the shared surfaces', () => {
    const scanFiles = [
      'app/App.vue',
      'app/components/TopPanel.vue',
      'app/components/ThreadBlock.vue',
      'app/components/OutputPanel.vue',
      'app/components/ProjectPicker.vue',
    ];
    for (const relative of scanFiles) {
      const absolute = path.join(REPO_ROOT, relative);
      if (!existsSync(absolute)) continue;
      const source = readFileSync(absolute, 'utf8').toLowerCase();
      expect(source, `${relative} renders a recents affordance`).not.toContain('recents');
      expect(source, `${relative} renders a web-link affordance`).not.toContain('web-link');
      expect(source, `${relative} renders a web-link affordance`).not.toContain('weblink');
    }
  });
});
