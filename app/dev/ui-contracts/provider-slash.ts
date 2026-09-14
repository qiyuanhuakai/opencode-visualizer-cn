import { defineComponent, h, ref } from 'vue';
import InputPanel from '../../components/InputPanel.vue';
import ProviderManagerModal from '../../components/ProviderManagerModal.vue';
import { installApp } from './runtime';

type ProviderFixture = {
  id: string;
  name: string;
  source: string;
  models: Record<string, { id: string; name: string }>;
};

export function providerScenario(): void {
  const providers: ProviderFixture[] = [
    {
      id: 'anthropic',
      name: '国际化 Provider With A Long Display Name',
      source: 'custom',
      models: {
        'org/model/with/slashes-and-a-long-name': {
          id: 'org/model/with/slashes-and-a-long-name',
          name: 'Long Model Name',
        },
      },
    },
    { id: 'openai', name: 'OpenAI', source: 'builtin', models: {} },
  ];
  installApp(
    defineComponent({
      setup() {
        const open = ref(false);
        queueMicrotask(() => (open.value = true));
        return () =>
          h(ProviderManagerModal, {
            open: open.value,
            providers,
            connectedProviderIds: providers.map((provider) => provider.id),
            selectedModel: 'anthropic/org/model/with/slashes-and-a-long-name',
            hiddenModels: [],
            providerConfig: { enabled_providers: providers.map((provider) => provider.id) },
            backendKind: 'opencode',
          });
      },
    }),
  );
}

export function slashScenario(): void {
  const message = ref('');
  const commands = Array.from({ length: 60 }, (_, index) => ({
    name: `command-${String(index).padStart(2, '0')}`,
    description: `Command ${index} with a long descriptive label for viewport stress`,
  }));
  installApp(
    defineComponent({
      setup: () => () =>
        h(
          'section',
          {
            'aria-label': 'Slash command menu',
            style: { height: '100dvh', display: 'flex', alignItems: 'flex-end', padding: '8px' },
          },
          [
            h('div', { style: { width: '100%', height: '180px' } }, [
              h(InputPanel, {
                messageInput: message.value,
                'onUpdate:messageInput': (value: string) => (message.value = value),
                canSend: true,
                selectedMode: 'build',
                agentOptions: [{ id: 'build', label: 'Build' }],
                hasAgentOptions: true,
                selectedModel: 'provider/model',
                selectedThinking: undefined,
                modelOptions: [],
                thinkingOptions: [],
                hasModelOptions: false,
                hasThinkingOptions: false,
                isThinking: false,
                canAbort: false,
                commands,
                attachments: [],
              }),
            ]),
          ],
        ),
    }),
  );
}
