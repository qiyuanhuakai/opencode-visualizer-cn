import { defineComponent, h, nextTick, ref } from 'vue';
import ThreadHistoryContent from '../../components/ThreadHistoryContent.vue';
import { fixtureApi, installApp, waitForRender } from './runtime';
import type { HistoryEntry } from './types';

function makeHistory(count: number, prefix = 'history'): HistoryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${prefix}-${index}`,
    kind: 'tool',
    time: index,
    part: {
      id: `${prefix}-${index}`,
      callID: `${prefix}-${index}`,
      sessionID: 'qa-session',
      messageID: `message-${index}`,
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: `printf ${prefix}-${index}` },
        output: '',
        title: 'shell',
        metadata: {},
        time: { start: index, end: index },
      },
    },
  }));
}

export function historyScenario(): void {
  const entries = ref<HistoryEntry[]>(makeHistory(140));
  installApp(
    defineComponent({
      setup() {
        fixtureApi.appendHistory = async (count = 1) => {
          const start = entries.value.length;
          entries.value = [...entries.value, ...makeHistory(count, `appended-${start}`)];
          await nextTick();
          await waitForRender();
        };
        fixtureApi.shrinkHistory = async (count = 36) => {
          entries.value = makeHistory(count, 'shrunk');
          await nextTick();
          await waitForRender();
        };
        return () =>
          h(
            'section',
            {
              id: 'history-scroll-host',
              class: 'floating-window-body',
              'aria-label': 'Thread history scroll viewport',
              style: {
                height: '320px',
                width: 'min(100%, 620px)',
                overflow: 'auto',
                margin: '12px',
                border: '1px solid #334155',
              },
            },
            [h(ThreadHistoryContent, { entries: entries.value })],
          );
      },
    }),
  );
}
