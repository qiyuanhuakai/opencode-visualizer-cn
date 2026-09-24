import { describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  expandProviderList,
  flushUi,
  mountProviderManager,
  openCodeBackend,
  requireElement,
  setProviderBackend,
} from './providerManagerModal.test-helpers';

const providers = [
  { id: 'connected', name: 'Zulu', models: {} },
  { id: 'beta-id', name: 'beta', models: {} },
  { id: 'openai', name: 'Alpha', models: {} },
  { id: 'fallback', name: '  ', models: {} },
];

async function mountDiscovery() {
  setProviderBackend(openCodeBackend());
  const result = await mountProviderManager({ providers, connectedProviderIds: ['connected'] });
  await expandProviderList(result.host);
  return result;
}

function names(host: HTMLElement) {
  return Array.from(host.querySelectorAll('.provider-mini-row-name'), (row) =>
    row.textContent?.trim(),
  );
}

describe('OpenCode provider discovery', () => {
  it('sorts by display name A-Z regardless of connection or popular-provider status', async () => {
    const { host } = await mountDiscovery();
    expect(names(host)).toEqual(['Alpha', 'beta', 'fallback', 'Zulu']);
  });

  it.each([
    ['  ALPha ', ['Alpha']],
    ['BETA-ID', ['beta']],
    ['absent', []],
    ['', ['Alpha', 'beta', 'fallback', 'Zulu']],
  ])(
    'filters names and ids for query %s without filtering connected management',
    async (query, expected) => {
      const { host } = await mountDiscovery();
      const input = requireElement<HTMLInputElement>(host, '.provider-discovery-search');
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await flushUi();
      expect(names(host)).toEqual(expected);
      expect(host.querySelectorAll('.provider-list-row')).toHaveLength(1);
      expect(host.querySelector('.provider-discovery-empty') !== null).toBe(expected.length === 0);
    },
  );

  it('moves keyboard focus to the first provider for a letter', async () => {
    const { host } = await mountDiscovery();
    const rail = requireElement<HTMLElement>(host, '.provider-letter-nav');
    expect(
      Array.from(rail.querySelectorAll('button'), (button) => button.textContent?.trim()),
    ).toEqual(['A', 'B', 'F', 'Z']);
    requireElement<HTMLElement>(host, '[data-provider-letter="Z"]').scrollIntoView = vi.fn();
    buttonByText(rail, 'Z').click();
    await flushUi();
    expect(
      document.activeElement?.querySelector('.provider-mini-row-name')?.textContent?.trim(),
    ).toBe('Zulu');
  });
});
