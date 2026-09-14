import { afterEach, describe, expect, it } from 'vitest';
import {
  codeRequest as request,
  installRenderWorker as startWorker,
  markdownRequest,
  type RenderWorkerHarness,
} from './renderWorker.test-helpers';

const activeHarnesses: RenderWorkerHarness[] = [];

async function worker(moduleTag: string): Promise<RenderWorkerHarness> {
  const harness = await startWorker(moduleTag);
  activeHarnesses.push(harness);
  return harness;
}

describe('render worker theme isolation', () => {
  afterEach(() => {
    while (activeHarnesses.length > 0) activeHarnesses.pop()?.restoreSelf();
  });

  it('keeps overlapping different-theme renders on their own theme', async () => {
    // Given: two requests begin before either theme transition has settled
    const darkBaseline = await worker('dark-baseline');
    const darkAlone = await darkBaseline.render(request('dark-baseline', 'github-dark'));
    const lightBaseline = await worker('light-baseline');
    const lightAlone = await lightBaseline.render(request('light-baseline', 'github-light'));
    const { render } = await worker('overlap');
    const dark = request('dark', 'github-dark');
    const light = request('light', 'github-light');

    // When: the requests are submitted back-to-back
    const [darkHtml, lightHtml] = await Promise.all([render(dark), render(light)]);

    // Then: each response has the colors selected by its request's theme
    expect(darkHtml).toBe(darkAlone);
    expect(lightHtml).toBe(lightAlone);
  });

  it('omits markdown copy controls when the caller disables them', async () => {
    const { render } = await worker('copy-controls');
    const html = await render({
      ...request('without-copy-controls', 'github-dark'),
      code: '# Result\n\n```text\noutput\n```',
      lang: 'markdown',
      copyButtons: false,
    });

    expect(html).toContain('Result');
    expect(html).not.toContain('md-copy-btn');
    expect(html).not.toContain('COPY');
    expect(html).not.toContain('Copied');
  });

  it('inserts code and fenced markdown requests into one cache and promotes a real code hit', async () => {
    const { cache, render } = await worker('request-cache');
    const code = Array.from({ length: 5_000 }, (_, index) => `promoted ${index}`).join('\n');
    const fencedCode = Array.from({ length: 5_000 }, (_, index) => `evicted ${index}`).join('\n');

    await render({ ...request('code-first'), code, lang: 'text' });
    await render(markdownRequest('markdown-first', `\`\`\`text\n${fencedCode}\n\`\`\``));

    const entriesAfterInsertion = [...cache.entries()];
    const codeEntry = entriesAfterInsertion.find(([key]) => key.startsWith('code:'));
    const markdownEntry = entriesAfterInsertion.find(([key]) => key.startsWith('markdown:'));
    expect(codeEntry?.[1]).toContain('promoted');
    expect(markdownEntry?.[1]).toContain('evicted');

    await render({ ...request('code-hit'), code, lang: 'text' });
    const codeKey = codeEntry?.[0];
    const markdownKey = markdownEntry?.[0];
    if (!codeKey || !markdownKey) throw new Error('expected code and markdown cache entries');
    expect([...cache.entries()].map(([key]) => key).at(-1)).toBe(codeKey);

    let newcomerIndex = 0;
    while (cache.has(markdownKey) && newcomerIndex < 60) {
      const newcomer = Array.from(
        { length: 1_000 },
        (_, index) => `newcomer ${newcomerIndex} ${index}`,
      ).join('\n');
      await render({ ...request(`code-new-${newcomerIndex}`), code: newcomer, lang: 'text' });
      newcomerIndex += 1;
    }

    expect(cache.has(codeKey)).toBe(true);
    expect(cache.has(markdownKey)).toBe(false);
    expect([...cache.entries()].filter(([key]) => key.startsWith('code:')).length).toBeGreaterThan(
      1,
    );
  });

  it('returns an oversized real render without retaining its cache entry', async () => {
    const { cache, render } = await worker('oversized');
    const oversized = Array.from({ length: 100_000 }, () => 'oversized').join('\n');

    const html = await render({ ...request('oversized-output'), code: oversized, lang: 'text' });

    expect(html).toContain('oversized');
    expect(
      [...cache.entries()].some(([key]) => key.startsWith('code:') && key.includes(oversized)),
    ).toBe(false);
  });
});
