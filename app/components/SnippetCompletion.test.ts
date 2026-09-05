import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import type { TextTransformer } from '../utils/snippets';
import SnippetCompletion from './SnippetCompletion.vue';

const mountedApps: Array<() => void> = [];
const componentSource = readFileSync(path.resolve(__dirname, './SnippetCompletion.vue'), 'utf8');

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  document.body.innerHTML = '';
});

describe('SnippetCompletion', () => {
  it('keeps legal long metadata inside the compact completion surface', async () => {
    // Given: one valid Snippet has the maximum tag count and a long trigger.
    const snippet: TextTransformer = {
      id: 'snippet-long-completion',
      trigger: `::${'长'.repeat(254)}`,
      name: 'Long completion',
      body: 'Body',
      enabled: true,
      tags: Array.from({ length: 256 }, (_, index) => `tag-${index}`),
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(
      defineComponent({
        setup: () => () => h(SnippetCompletion, { snippet, sequence: snippet.trigger }),
      }),
    );
    app.mount(host);
    mountedApps.push(() => app.unmount());
    await nextTick();

    // When: the completion renders its metadata.
    const trigger = host.querySelector<HTMLElement>('.snippet-completion-trigger');
    const tags = Array.from(host.querySelectorAll('.snippet-completion-tag'));

    // Then: the full trigger remains discoverable while visible tags stay bounded.
    expect(trigger?.title).toBe(snippet.trigger);
    expect(tags).toHaveLength(5);
    expect(tags.slice(0, 4).map((tag) => tag.textContent?.trim())).toEqual([
      'tag-0',
      'tag-1',
      'tag-2',
      'tag-3',
    ]);
    expect(tags[4]?.textContent?.trim()).toBe('+252');
  });

  it('bounds a maximum unbroken description inside the compact completion surface', async () => {
    // Given: one valid Snippet has the maximum legal description without break opportunities.
    const description = '界'.repeat(4_096);
    const snippet: TextTransformer = {
      id: 'snippet-long-description',
      trigger: 'long-description',
      name: 'Long description',
      description,
      body: 'Body',
      enabled: true,
      tags: [],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(
      defineComponent({
        setup: () => () => h(SnippetCompletion, { snippet, sequence: snippet.trigger }),
      }),
    );
    app.mount(host);
    mountedApps.push(() => app.unmount());
    await nextTick();

    // When: the compact row renders the description.
    const rendered = host.querySelector<HTMLElement>('.snippet-completion-description');

    // Then: DOM text is bounded, full content remains discoverable, and CSS clamps unbroken text.
    expect(rendered?.textContent).toHaveLength(240);
    expect(rendered?.title).toBe(description);
    expect(componentSource).toMatch(
      /\.snippet-completion-description[\s\S]*?-webkit-line-clamp:\s*2/u,
    );
    expect(componentSource).toMatch(
      /\.snippet-completion-description[\s\S]*?overflow-wrap:\s*anywhere/u,
    );
  });
});
