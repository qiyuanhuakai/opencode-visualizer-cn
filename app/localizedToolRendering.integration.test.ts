import { afterEach, describe, expect, it, vi } from 'vitest';

const renderWorkerTransport = vi.hoisted(() => vi.fn(async () => '<pre>rendered</pre>'));

vi.mock('./utils/workerRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/workerRenderer')>();
  return { ...actual, renderWorkerHtml: renderWorkerTransport };
});

import { setLocale } from './i18n';
import { mountRuntimeApp } from './test/runtimeAppHarness';
import type { JsonValue } from '../shared/runtime/capabilities.js';

afterEach(() => {
  setLocale('en');
  renderWorkerTransport.mockClear();
});

function completedTool(
  sessionID: string,
  tool: string,
  input: Record<string, JsonValue>,
  output: string,
): Parameters<typeof mountRuntimeApp>[0] {
  const messageID = `assistant-${sessionID}`;
  const id = `tool-${sessionID}`;
  const parentID = `user-${sessionID}`;
  return [{
    info: { id: parentID, sessionID, role: 'user', time: { created: 1 } },
    parts: [{ id: `prompt-${sessionID}`, messageID: parentID, sessionID, type: 'text', text: 'Inspect tool output' }],
  }, {
    info: {
      id: messageID, sessionID, role: 'assistant', parentID,
      time: { created: 10, completed: 11 }, providerID: 'provider-a', modelID: 'model-a', mode: 'build',
    },
    parts: [{
      id, callID: id, messageID, sessionID, type: 'tool', tool,
      state: { status: 'completed', input, output, time: { start: 10, end: 11 } },
    }],
  }];
}

async function openTool(fixture: Awaited<ReturnType<typeof mountRuntimeApp>>, session: string, nativeId: string, summary?: string) {
  await fixture.select(session);
  await vi.waitFor(() => expect(fixture.historyPages.at(-1)?.session.nativeSessionId).toBe(nativeId));
  const history = await vi.waitFor(() => {
    const button = fixture.element.querySelector<HTMLButtonElement>('.ib-action-history');
    expect(button).toBeTruthy();
    return button!;
  });
  history.click();
  const tool = await vi.waitFor(() => {
    const rows = fixture.element.querySelectorAll<HTMLElement>('[data-floating-key="thread-history"] .history-item-tool');
    const row = summary ? [...rows].find(item => item.textContent?.includes(summary)) : rows[0];
    expect(row).toBeTruthy();
    return row!;
  });
  tool.click();
}

describe('App localized tool rendering through Bridge history', () => {
  it('uses the request locale when opening completed shell tools from different sessions', async () => {
    const fixture = await mountRuntimeApp([
      ...completedTool('session-a', 'bash', { command: 'printf english' }, 'english output'),
      ...completedTool('session-b', 'bash', { command: 'printf chinese' }, '中文输出'),
    ]);
    await fixture.connect();

    setLocale('en');
    await openTool(fixture, 'Session A', 'session-a', 'printf english');
    await vi.waitFor(() => expect(renderWorkerTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        code: '$ printf english\n\nenglish output',
        lang: 'shellscript',
        theme: 'github-dark',
        gutterMode: 'none',
        copyButtonLabel: 'COPY',
        copiedLabel: '✓ Copied',
        copyCodeAriaLabel: 'Copy code',
        copyMarkdownAriaLabel: 'Copy markdown',
      }),
    ));

    setLocale('zh-CN');
    await openTool(fixture, 'Session B', 'session-b', 'printf chinese');
    await vi.waitFor(() => expect(renderWorkerTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        code: '$ printf chinese\n\n中文输出',
        lang: 'shellscript',
        theme: 'github-dark',
        gutterMode: 'none',
        copyButtonLabel: '复制',
        copiedLabel: '✓ 已复制',
        copyCodeAriaLabel: '复制代码',
        copyMarkdownAriaLabel: '复制 Markdown',
      }),
    ));
  }, 15000);

  it('preserves webfetch markdown and intentionally empty copy labels', async () => {
    const output = '# Payload retained\n\nThe transport receives this exact content.';
    const fixture = await mountRuntimeApp([
      ...completedTool('session-a', 'webfetch', { url: 'https://example.test/article', format: 'markdown' }, output),
    ]);
    await fixture.connect();
    await openTool(fixture, 'Session A', 'session-a');

    await vi.waitFor(() => expect(renderWorkerTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        code: output,
        lang: 'markdown',
        theme: 'github-dark',
        gutterMode: 'none',
        copyButtonLabel: '',
        copiedLabel: '',
        copyCodeAriaLabel: '',
        copyMarkdownAriaLabel: '',
      }),
    ));
  }, 15000);
});
