import { createApp, nextTick, ref, type App as VueApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useCodexApi } from '../../composables/useCodexApi';
import CodexFsInspector from './CodexFsInspector.vue';

const apps: VueApp[] = [];

afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
});

describe('CodexFsInspector', () => {
  it('reads metadata and owns a watch/unwatch lifecycle for the selected path', async () => {
    const fsGetMetadata = vi.fn().mockResolvedValue({ metadata: { kind: 'file', size: 12 } });
    const fsWatch = vi.fn().mockResolvedValue(undefined);
    const fsUnwatch = vi.fn().mockResolvedValue(undefined);
    const api = {
      previewFilePath: ref('/workspace/file.ts'), fsCwd: ref('/workspace'), connected: ref(true),
      fsGetMetadata, fsWatch, fsUnwatch,
    } as unknown as ReturnType<typeof useCodexApi>;
    const target = document.createElement('div');
    document.body.append(target);
    const app = createApp(CodexFsInspector, { api });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: { codexPanel: { fsInspector: { title: 'File metadata & watch', path: 'Path', metadata: 'Metadata', watch: 'Watch', unwatch: 'Unwatch' } }, common: { loading: 'Loading' } } } }));
    apps.push(app);
    app.mount(target);

    const buttons = () => Array.from(target.querySelectorAll('button'));
    buttons().find((button) => button.textContent?.trim() === 'Metadata')?.click();
    await vi.waitFor(() => expect(target.textContent).toContain('"size": 12'));
    expect(fsGetMetadata).toHaveBeenCalledWith('/workspace/file.ts');

    buttons().find((button) => button.textContent?.trim() === 'Watch')?.click();
    await vi.waitFor(() => expect(fsWatch).toHaveBeenCalledOnce());
    const watchId = fsWatch.mock.calls[0]?.[0];
    expect(typeof watchId).toBe('string');
    expect(fsWatch).toHaveBeenCalledWith(watchId, '/workspace/file.ts');

    await nextTick();
    buttons().find((button) => button.textContent?.trim() === 'Unwatch')?.click();
    await vi.waitFor(() => expect(fsUnwatch).toHaveBeenCalledWith(watchId));
  });
});
