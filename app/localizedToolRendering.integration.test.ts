import { afterEach, describe, expect, it, vi } from 'vitest';

const renderWorkerTransport = vi.hoisted(() => vi.fn(async () => '<pre>rendered</pre>'));

vi.mock('./utils/workerRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/workerRenderer')>();
  return { ...actual, renderWorkerHtml: renderWorkerTransport };
});

import { setLocale } from './i18n';
import { mountHistoryApp } from './test/appHarness';

const mountedApps: Array<{ readonly unmount: () => void }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ unmount }) => unmount());
  setLocale('en');
  renderWorkerTransport.mockClear();
});

describe('App localized tool rendering', () => {
  it('Given a mounted App, When completed tool notifications arrive after each locale change, Then its renderer transport receives that request locale defaults', async () => {
    const fixture = await mountHistoryApp([]);
    mountedApps.push(fixture);
    renderWorkerTransport.mockClear();

    setLocale('en');
    fixture.emitSessionEvent('message.part.updated', {
      part: {
        id: 'tool-bash-en',
        callID: 'tool-bash-en',
        type: 'tool',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'printf english' },
          output: 'english output',
        },
      },
    });

    await vi.waitFor(() => expect(renderWorkerTransport).toHaveBeenCalledTimes(1));
    expect(renderWorkerTransport).toHaveBeenLastCalledWith(
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
    );

    setLocale('zh-CN');
    fixture.emitSessionEvent('message.part.updated', {
      part: {
        id: 'tool-bash-zh',
        callID: 'tool-bash-zh',
        type: 'tool',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'printf chinese' },
          output: '中文输出',
        },
      },
    });

    await vi.waitFor(() => expect(renderWorkerTransport).toHaveBeenCalledTimes(2));
    expect(renderWorkerTransport).toHaveBeenLastCalledWith(
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
    );
  });

  it('Given a mounted App, When a webfetch tool notification supplies empty labels, Then its worker payload preserves them and its content', async () => {
    const fixture = await mountHistoryApp([]);
    mountedApps.push(fixture);
    renderWorkerTransport.mockClear();

    fixture.emitSessionEvent('message.part.updated', {
      part: {
        id: 'tool-webfetch-empty-labels',
        callID: 'tool-webfetch-empty-labels',
        type: 'tool',
        tool: 'webfetch',
        state: {
          status: 'completed',
          input: { url: 'https://example.test/article', format: 'markdown' },
          output: '# Payload retained\n\nThe transport receives this exact content.',
        },
      },
    });

    await vi.waitFor(() => expect(renderWorkerTransport).toHaveBeenCalledTimes(1));
    expect(renderWorkerTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        code: '# Payload retained\n\nThe transport receives this exact content.',
        lang: 'markdown',
        theme: 'github-dark',
        gutterMode: 'none',
        copyButtonLabel: '',
        copiedLabel: '',
        copyCodeAriaLabel: '',
        copyMarkdownAriaLabel: '',
      }),
    );
  });
});
