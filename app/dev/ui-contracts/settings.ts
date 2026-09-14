import { defineComponent, h, ref } from 'vue';
import { useSettings } from '../../composables/useSettings';
import { installApp } from './runtime';

export async function settingsScenario(initialPage: 'fonts' | 'desktop' | 'editor'): Promise<void> {
  useSettings().localApplicationPath.value = '/opt/编辑器/bin/code-with-a-long-name';
  const { default: SettingsModal } = await import('../../components/SettingsModal.vue');
  installApp(
    defineComponent({
      setup() {
        const open = ref(false);
        queueMicrotask(() => (open.value = true));
        return () => h(SettingsModal, { open: open.value, initialPage });
      },
    }),
  );
}
