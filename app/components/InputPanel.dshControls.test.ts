import { nextTick } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../locales/en';
import { cleanupInputPanelFixtures, mountInputPanel } from './inputPanel.test-helpers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
afterEach(cleanupInputPanelFixtures);

it('omits unavailable agent and reasoning controls while retaining the model picker', async () => {
  const { root } = mountInputPanel({ hideAgentPicker: true, hideThinkingPicker: true });
  await nextTick();
  expect(root.querySelector(`.ui-dropdown[title="${en.inputPanel.agentTitle}"]`)).toBeNull();
  expect(root.querySelector(`.ui-dropdown[title="${en.inputPanel.variantTitle}"]`)).toBeNull();
  expect(root.querySelector(`.ui-dropdown[title="${en.inputPanel.modelTitle}"]`)).not.toBeNull();
});
