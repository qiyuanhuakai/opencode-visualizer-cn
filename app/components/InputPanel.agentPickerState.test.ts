import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import {
  cleanupInputPanelFixtures,
  mountInputPanel,
  type InputPanelTestOverrides,
} from './inputPanel.test-helpers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

/**
 * R4 (S3) — the AGENT selector at the bottom of the input bar shows a
 * perpetual "loading" state for kimi-web.
 *
 * Root cause: `InputPanel.vue` renders the agent selector's loading
 * placeholder whenever `hasAgentOptions` is false, and for kimi-web
 * `agentOptions` is deliberately `[]` (App.vue `fetchAgents` — kimi is
 * single-agent, so there is genuinely nothing to list). The UI therefore
 * cannot distinguish "still loading" from "not supported by this backend"
 * and looks stuck forever.
 *
 * The fix (Wave 2) adds an explicit three-way picker state; this RED test
 * pins that contract.
 *
 * PINNED PROP CONTRACT (Wave 2 must implement exactly this on InputPanel.vue):
 *   prop name : `agentPickerState`
 *   type      : `'loading' | 'unsupported' | 'ready'`
 *   optional  : yes — when omitted the state is derived as today,
 *               `hasAgentOptions ? 'ready' : 'loading'`, so every backend that
 *               does not pass the prop keeps its current behavior.
 *   'loading'     → the loading placeholder (`inputPanel.loadingAgents`)
 *   'unsupported' → the not-supported copy (`inputPanel.agentUnsupported`) and
 *                   NEVER the loading placeholder
 *   'ready'       → the normal agent list
 *
 * PINNED i18n KEY (Wave 2 must add it to every locale under `inputPanel`):
 *   `inputPanel.agentUnsupported` = 'Agent selection is not supported by this
 *   backend.'  (backend-agnostic wording, mirroring the statusMonitor
 *   `unsupported` copy convention)
 */

type AgentPickerState = 'loading' | 'unsupported' | 'ready';

/**
 * `activeBackendKind` is passed only as reproduction context (App.vue feeds it
 * to the composer); the pinned contract is `agentPickerState` alone, which
 * stays backend-agnostic so codex (`codexAgentOptions`) and acp keep working.
 */
type AgentPickerMountOverrides = InputPanelTestOverrides & {
  agentPickerState?: AgentPickerState;
  activeBackendKind?: string;
};

const AGENT_SELECTOR_TITLE = en.inputPanel.agentTitle; // 'Agent (Tab)'
const LOADING_AGENTS_COPY = en.inputPanel.loadingAgents; // 'Loading agents...'
const AGENT_UNSUPPORTED_COPY = 'Agent selection is not supported by this backend.';

/** The agent selector region: the Dropdown titled `inputPanel.agentTitle`. */
function agentSelectorRegion(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.ui-dropdown[title="${AGENT_SELECTOR_TITLE}"]`);
}

function mountAgentPicker(overrides: AgentPickerMountOverrides) {
  return mountInputPanel(overrides);
}

describe(
  'InputPanel agent picker three-way state — R4/S3 · prop contract: agentPickerState?: "loading" | "unsupported" | "ready" (omitted ⇒ hasAgentOptions ? "ready" : "loading") · i18n key: inputPanel.agentUnsupported',
  () => {
    afterEach(() => {
      cleanupInputPanelFixtures();
    });

    it('RED: kimi-web (agentOptions [], agentPickerState "unsupported") shows the not-supported copy, never the loading placeholder', async () => {
      const { root } = mountAgentPicker({
        activeBackendKind: 'kimi-web',
        agentOptions: [],
        hasAgentOptions: false,
        agentPickerState: 'unsupported',
      });
      await nextTick();

      const region = agentSelectorRegion(root);
      expect(region).not.toBeNull();

      const text = region?.textContent ?? '';
      // RED today: the not-supported copy does not exist yet, so this fails.
      expect(text).toContain(AGENT_UNSUPPORTED_COPY);
      // RED today: the loading placeholder is rendered instead, so this fails.
      expect(text).not.toContain(LOADING_AGENTS_COPY);
    });

    it('characterization: opencode (agentOptions [], agentPickerState "loading") still shows the loading placeholder', async () => {
      const { root } = mountAgentPicker({
        activeBackendKind: 'opencode',
        agentOptions: [],
        hasAgentOptions: false,
        agentPickerState: 'loading',
      });
      await nextTick();

      const region = agentSelectorRegion(root);
      expect(region).not.toBeNull();

      const text = region?.textContent ?? '';
      // Guards the other backends: while agents load, the placeholder stays.
      expect(text).toContain(LOADING_AGENTS_COPY);
      expect(text).not.toContain(AGENT_UNSUPPORTED_COPY);
    });
  },
);
