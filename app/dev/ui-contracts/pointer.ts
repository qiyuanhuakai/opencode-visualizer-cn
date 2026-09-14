import { defineComponent, h, reactive } from 'vue';
import FloatingWindow from '../../components/FloatingWindow.vue';
import { useFloatingWindows, type FloatingWindowEntry } from '../../composables/useFloatingWindows';
import { fixtureApi, installApp } from './runtime';

export function pointerScenario(): void {
  const entry = reactive<FloatingWindowEntry>({
    key: 'qa-pointer-window',
    title: 'Pointer capture contract',
    content: '<p>Drag and resize this real floating window.</p>',
    resolvedHtml: '',
    isReady: true,
    variant: 'plain',
    x: 40,
    y: 40,
    width: 360,
    height: 240,
    zIndex: 10,
    closable: true,
    resizable: true,
    scroll: 'manual',
    time: Date.now(),
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  const pointerCapture = { drag: false, resize: false };
  fixtureApi.pointerCapture = pointerCapture;
  fixtureApi.floatingEntry = entry;
  document.addEventListener(
    'pointerdown',
    (event) => {
      fixtureApi.pointerId = event.pointerId;
    },
    true,
  );
  installApp(
    defineComponent({
      setup() {
        const manager = useFloatingWindows();
        return () =>
          h(
            'section',
            {
              style: { position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' },
            },
            [h(FloatingWindow, { entry, manager })],
          );
      },
    }),
  );
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const windowElement = target.closest<HTMLElement>('.floating-window');
    if (!windowElement) return;
    if (target.closest('.floating-window-titlebar')) {
      pointerCapture.drag =
        target
          .closest<HTMLElement>('.floating-window-titlebar')
          ?.hasPointerCapture(event.pointerId) ?? false;
    }
    if (target.closest('.floating-window-resizer')) {
      pointerCapture.resize = windowElement.hasPointerCapture(event.pointerId);
    }
  });
}
