import { readFileSync } from 'node:fs';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupInputPanelFixtures, mountInputPanel } from './inputPanel.test-helpers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const source = readFileSync('app/App.vue', 'utf8');
const presets = [{ id: 'standard', label: 'Standard' }];
const subagents = [{ id: 'explore', label: 'Explore' }];
function mentionBinding(name: string, backend: string) {
  const expression = source.match(new RegExp(`:${name}="([^"]+)"`))?.[1];
  if (!expression) throw new Error(`Missing composer binding: ${name}`);
  return new Function('activeBackendKind', 'dshComposerClient', 'agentOptions', 'subagentOptions', `return (${expression})`)(
    backend, backend === 'dsh' ? {} : null, presets, subagents,
  );
}
function mount(backend: string, query = '@', files = ['src/example.ts']) {
  return mountInputPanel({
    messageInput: query,
    agentOptions: presets,
    subagentOptions: mentionBinding('subagent-options', backend),
    mentionAgentOptions: mentionBinding('mention-agent-options', backend),
    preferFileMentions: mentionBinding('prefer-file-mentions', backend),
    mentionFiles: files,
  });
}

afterEach(cleanupInputPanelFixtures);
describe('App DSH mention wiring', () => {
  it('offers files instead of presets or stale backend agents and inserts the chosen file', async () => {
    const { root, props } = mount('dsh');
    props['onUpdate:messageInput'] = value => { props.messageInput = value; };
    await nextTick();
    expect(root.querySelector('#input-mention-listbox')?.textContent).toContain('src/');
    expect(root.querySelector('#input-mention-listbox')?.textContent).not.toMatch(/Standard|Explore/);
    root.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(root.querySelector('#input-mention-listbox')?.textContent).toContain('example.ts'));
    root.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await nextTick();
    expect(props.messageInput).toBe('@src/example.ts ');
  });

  it.each(['@', '@standard', '@explore'])('does not fall back to agents when %s matches no file', async query => {
    const { root } = mount('dsh', query, []);
    await nextTick();
    expect(root.querySelector('textarea')?.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelectorAll('#input-mention-listbox [role="option"]')).toHaveLength(0);
  });

  it('preserves primary and subagent mentions for OpenCode', async () => {
    const { root } = mount('opencode');
    await nextTick();
    expect(root.querySelector('#input-mention-listbox')?.textContent).toContain('Standard');
    expect(root.querySelector('#input-mention-listbox')?.textContent).toContain('Explore');
  });
});
