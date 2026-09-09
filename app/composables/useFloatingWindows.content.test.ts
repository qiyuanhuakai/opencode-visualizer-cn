import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { useFloatingWindows } from './useFloatingWindows';

const apps: App[] = [];
function mountWindows() {
  let manager: ReturnType<typeof useFloatingWindows> | undefined;
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp({
    setup() {
      const windows = useFloatingWindows();
      manager = windows;
      return () => h('div', windows.entries.value.map(entry =>
        h('article', { 'data-key': entry.key, innerHTML: entry.resolvedHtml })));
    },
  });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } }));
  app.mount(host);
  apps.push(app);
  if (!manager) throw new Error('Manager missing');
  return { manager, host };
}

afterEach(() => {
  apps.splice(0).forEach(app => app.unmount());
  document.body.innerHTML = '';
});

describe('floating window content ownership', () => {
  it('renders an automatic popup after status and geometry change during rendering', async () => {
    const { manager, host } = mountWindows();
    const content = Promise.withResolvers<string>();
    await manager.open('codex-edit', { content: () => content.promise, expiry: Infinity });
    manager.updateOptions('codex-edit', { status: 'completed' });
    manager.updateOptions('codex-edit', { x: 20, width: 500 });
    content.resolve('<pre>first diff</pre>');
    await content.promise;
    await nextTick();
    expect(host.querySelector('article')?.textContent).toBe('first diff');
  });

  it('renders every window after layout updates and out-of-order completion', async () => {
    const { manager, host } = mountWindows();
    const renders = [0, 1, 2].map(() => Promise.withResolvers<string>());
    for (const [index, render] of renders.entries()) {
      await manager.open(`edit-${index}`, { content: () => render.promise, expiry: Infinity });
      for (let previous = 0; previous < index; previous++) {
        manager.updateOptions(`edit-${previous}`, { x: previous * 20 });
      }
    }
    for (const index of [2, 0, 1]) renders[index]?.resolve(`<pre>diff ${index}</pre>`);
    await Promise.all(renders.map(render => render.promise));
    await nextTick();
    expect(Array.from(host.querySelectorAll('article'), node => node.textContent)).toEqual(['diff 0', 'diff 1', 'diff 2']);
  });
});

it('keeps newer content authoritative after an options update', async () => {
  const { manager, host } = mountWindows();
  const oldRender = Promise.withResolvers<string>();
  await manager.open('changed', { content: () => oldRender.promise, expiry: Infinity });
  manager.updateOptions('changed', { width: 500 });
  await manager.setContent('changed', '<pre>new content</pre>');
  oldRender.resolve('<pre>stale content</pre>');
  await oldRender.promise;
  await nextTick();
  expect(host.querySelector('article')?.textContent).toBe('new content');
});

it('ignores old rendering after closing and reopening the same key', async () => {
  const { manager, host } = mountWindows();
  const oldRender = Promise.withResolvers<string>();
  await manager.open('reopened', { content: () => oldRender.promise, expiry: Infinity });
  manager.updateOptions('reopened', { x: 20 });
  await manager.close('reopened');
  await manager.open('reopened', { content: '<pre>reopened content</pre>', expiry: Infinity });
  oldRender.resolve('<pre>closed content</pre>');
  await oldRender.promise;
  await nextTick();
  expect(host.querySelector('article')?.textContent).toBe('reopened content');
});
