import {
  type AllowedComponentProps,
  createApp,
  defineComponent,
  h,
  reactive,
  resolveComponent,
  type App,
  type ComponentCustomProps,
  type VNodeProps,
} from 'vue';
import { createI18n } from 'vue-i18n';
import en from '../locales/en';
import InputPanel from './InputPanel.vue';

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type InputPanelProps = Mutable<
  Omit<
    InstanceType<typeof InputPanel>['$props'],
    keyof VNodeProps | keyof AllowedComponentProps | keyof ComponentCustomProps
  >
>;
type InputPanelEventProps = {
  onOpenSnippetSettings?: () => void;
  onSend?: () => void;
  onStatusError?: (message: string) => void;
  onTogglePlan?: (enabled: boolean) => void;
  'onUpdate:messageInput'?: (value: string) => void;
};
type InputPanelMountProps = InputPanelProps & InputPanelEventProps;
export type InputPanelTestOverrides = Partial<InputPanelMountProps>;

export const INPUT_PANEL_DEFAULT_PROPS = Object.freeze({
  messageInput: '',
  canSend: true,
  selectedMode: 'build',
  agentOptions: Object.freeze([Object.freeze({ id: 'build', label: 'Build' })]),
  subagentOptions: Object.freeze([]),
  hasAgentOptions: true,
  selectedModel: 'openai/gpt',
  selectedThinking: undefined,
  modelOptions: Object.freeze([
    Object.freeze({
      id: 'openai/gpt',
      modelID: 'gpt',
      label: 'GPT',
      displayName: 'GPT',
      providerID: 'openai',
    }),
  ]),
  thinkingOptions: Object.freeze([undefined]),
  hasModelOptions: true,
  hasThinkingOptions: true,
  isThinking: false,
  canAbort: false,
  commands: Object.freeze([]),
  attachments: Object.freeze([]),
});

const mountedApps = new Set<App>();

export function mountInputPanel(overrides: InputPanelTestOverrides = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const props = reactive<InputPanelMountProps>({
    ...INPUT_PANEL_DEFAULT_PROPS,
    agentOptions: INPUT_PANEL_DEFAULT_PROPS.agentOptions.map((option) => ({ ...option })),
    subagentOptions: [],
    modelOptions: INPUT_PANEL_DEFAULT_PROPS.modelOptions.map((option) => ({ ...option })),
    thinkingOptions: [...INPUT_PANEL_DEFAULT_PROPS.thinkingOptions],
    commands: [],
    attachments: [],
    ...overrides,
  });
  const app = createApp(
    defineComponent({
      setup: () => () => h(resolveComponent('InputPanel'), props),
    }),
  );
  mountedApps.add(app);
  app.component('InputPanel', InputPanel);
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.provide('showConfirm', async () => true);
  app.mount(root);
  return {
    app,
    props,
    root,
    unmount: () => {
      if (!mountedApps.delete(app)) return;
      app.unmount();
      root.remove();
    },
  };
}

export function cleanupInputPanelFixtures() {
  for (const app of mountedApps) app.unmount();
  mountedApps.clear();
  document.body.replaceChildren();
}
