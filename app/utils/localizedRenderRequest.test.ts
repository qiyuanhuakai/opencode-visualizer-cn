import { describe, expect, it, vi } from 'vitest';

import { createLocalizedRenderRequest } from './localizedRenderRequest';
import type { RenderRequest } from './workerRenderer';

const request = {
  id: 'render-1',
  code: '# Test',
  lang: 'markdown',
  theme: 'github-dark',
  gutterMode: 'single',
} satisfies RenderRequest;

describe('createLocalizedRenderRequest', () => {
  it('resolves default labels for every request using the current locale', async () => {
    let locale = 'en';
    const renderer = vi.fn(async () => '<pre>rendered</pre>');
    const renderLocalized = createLocalizedRenderRequest((key) => `${locale}:${key}`, renderer);

    await renderLocalized(request);
    locale = 'zh';
    await renderLocalized({ ...request, id: 'render-2' });

    expect(renderer).toHaveBeenNthCalledWith(1, {
      ...request,
      copyButtonLabel: 'en:render.copyCode',
      copiedLabel: 'en:render.copied',
      copyCodeAriaLabel: 'en:render.copyCodeAria',
      copyMarkdownAriaLabel: 'en:render.copyMarkdownAria',
    });
    expect(renderer).toHaveBeenNthCalledWith(2, {
      ...request,
      id: 'render-2',
      copyButtonLabel: 'zh:render.copyCode',
      copiedLabel: 'zh:render.copied',
      copyCodeAriaLabel: 'zh:render.copyCodeAria',
      copyMarkdownAriaLabel: 'zh:render.copyMarkdownAria',
    });
  });

  it('preserves explicit empty labels and passes the remaining payload through', async () => {
    const renderer = vi.fn(async () => '<pre>rendered</pre>');
    const renderLocalized = createLocalizedRenderRequest((key) => `default:${key}`, renderer);
    const explicitRequest = {
      ...request,
      copyButtonLabel: '',
      copiedLabel: '',
      copyCodeAriaLabel: '',
      copyMarkdownAriaLabel: '',
      copyButtons: false,
      files: ['first.ts', 'second.ts'],
      lineOffset: 7,
    } satisfies RenderRequest;

    await expect(renderLocalized(explicitRequest)).resolves.toBe('<pre>rendered</pre>');

    expect(renderer).toHaveBeenCalledWith(explicitRequest);
  });
});
