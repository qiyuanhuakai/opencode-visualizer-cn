import { createApp, h, nextTick, ref, type App as VueApp } from 'vue';
import { afterEach, beforeEach, vi } from 'vitest';
import type { BackendKind } from '../backends/types';
import i18n from '../i18n';
import ProviderManagerModal from './ProviderManagerModal.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const registryMock = vi.hoisted(() => ({
  getAdapter: vi.fn(),
}));

vi.mock('../backends/registry', () => ({
  getActiveBackendAdapter: () => registryMock.getAdapter(),
}));

type ProviderModel = {
  readonly id: string;
  readonly name?: string;
};

type ProviderInfo = {
  readonly id: string;
  readonly name?: string;
  readonly source?: string;
  readonly models?: Record<string, ProviderModel>;
};

type ProviderConfigState = {
  readonly enabled_providers?: string[];
  readonly disabled_providers?: string[];
  readonly provider?: Record<string, unknown>;
  readonly model_providers?: Record<string, unknown>;
};

type MountedModalOptions = {
  readonly backendKind?: BackendKind;
  readonly providers?: readonly ProviderInfo[];
  readonly connectedProviderIds?: readonly string[];
  readonly selectedModel?: string;
  readonly hiddenModels?: readonly string[];
  readonly providerConfig?: ProviderConfigState | null;
  readonly showPrompt?: (title: string, defaultValue?: string) => Promise<string | null>;
  readonly showConfirm?: (message: string) => Promise<boolean>;
};

type MountedModal = {
  readonly host: HTMLElement;
  readonly app: VueApp<Element>;
  readonly events: {
    readonly configUpdated: ReturnType<typeof vi.fn>;
    readonly modelVisibility: ReturnType<typeof vi.fn>;
    readonly providersChanged: ReturnType<typeof vi.fn>;
    readonly selectModel: ReturnType<typeof vi.fn>;
  };
  readonly setOpen: (open: boolean) => Promise<void>;
};

const mounted: MountedModal[] = [];
const dialogMethods = {
  showModal: HTMLDialogElement.prototype.showModal,
  close: HTMLDialogElement.prototype.close,
};

export function requireElement<T extends Element>(root: ParentNode, selector: string) {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

export function buttonByText(root: ParentNode, text: string) {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

export function providerConnectButton(root: ParentNode, providerId: string) {
  const row = Array.from(root.querySelectorAll<HTMLElement>('.provider-mini-row')).find((entry) =>
    entry.textContent?.includes(providerId),
  );
  if (!row) throw new Error(`Missing provider row: ${providerId}`);
  return requireElement<HTMLButtonElement>(row, 'button');
}

export async function expandProviderList(host: HTMLElement) {
  requireElement<HTMLButtonElement>(host, '.provider-view-all-toggle').click();
  await flushUi();
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function changeCheckbox(input: HTMLInputElement, checked: boolean) {
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function setProviderBackend(backend: unknown) {
  registryMock.getAdapter.mockReturnValue(backend);
}

export async function flushUi() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

export async function mountProviderManager(
  options: MountedModalOptions = {},
): Promise<MountedModal> {
  const props = ref({
    open: options.backendKind === undefined,
    providers: [...(options.providers ?? [])],
    connectedProviderIds: [...(options.connectedProviderIds ?? [])],
    selectedModel: options.selectedModel ?? '',
    hiddenModels: [...(options.hiddenModels ?? [])],
    providerConfig: options.providerConfig ?? null,
    backendKind: options.backendKind ?? 'opencode',
  });
  const events = {
    configUpdated: vi.fn(),
    modelVisibility: vi.fn(),
    providersChanged: vi.fn(),
    selectModel: vi.fn(),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(ProviderManagerModal, {
        ...props.value,
        onConfigUpdated: events.configUpdated,
        onProvidersChanged: events.providersChanged,
        onSelectModel: events.selectModel,
        'onUpdate:model-visibility': events.modelVisibility,
      }),
  });
  app.use(i18n);
  app.provide('showPrompt', options.showPrompt ?? (async () => null));
  app.provide('showConfirm', options.showConfirm ?? (async () => true));
  app.mount(host);
  const modal = {
    host,
    app,
    events,
    setOpen: async (open: boolean) => {
      props.value = { ...props.value, open };
      await flushUi();
    },
  };
  mounted.push(modal);
  await flushUi();
  return modal;
}

export function openCodeBackend(methods: Record<string, unknown[]> = {}) {
  return {
    kind: 'opencode',
    updateGlobalConfig: vi.fn(async (payload: Record<string, unknown>) => payload),
    setProviderAuth: vi.fn(async () => undefined),
    deleteProviderAuth: vi.fn(async () => undefined),
    listProviderAuthMethods: vi.fn(async () => methods),
    authorizeProviderOAuth: vi.fn(async () => ({ method: 'auto', instructions: 'Done', url: '' })),
    completeProviderOAuth: vi.fn(async () => undefined),
  };
}

export function conditionalAuthMethods() {
  return {
    oauthy: [
      {
        type: 'oauth',
        prompts: [
          {
            type: 'select',
            key: 'region',
            options: ['eu', 'us'],
          },
          {
            type: 'text',
            key: 'tenant',
            when: { key: 'region', op: 'eq', value: 'eu' },
          },
          {
            type: 'text',
            key: 'notUs',
            when: { key: 'region', op: 'neq', value: 'us' },
          },
          {
            type: 'text',
            key: 'usOnly',
            when: { key: 'region', op: 'eq', value: 'us' },
          },
        ],
      },
    ],
  };
}

export function codexBackend() {
  return {
    kind: 'codex',
    updateGlobalConfig: vi.fn(async (payload: Record<string, unknown>) => payload),
    deleteProviderAuth: vi.fn(async () => undefined),
    listProviderAuthMethods: vi.fn(async () => ({})),
  };
}

export async function submitCustomProvider(
  host: HTMLElement,
  values: {
    readonly providerId: string;
    readonly name: string;
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly modelId: string;
    readonly modelName: string;
    readonly headerKey?: string;
    readonly headerValue?: string;
  },
) {
  await expandProviderList(host);
  requireElement<HTMLButtonElement>(host, '.custom-provider-entry .ghost-action').click();
  await flushUi();

  const fields = host.querySelectorAll<HTMLInputElement>('.custom-provider-field input');
  const modelFields = host.querySelectorAll<HTMLInputElement>('.custom-provider-row input');
  setInputValue(requireIndexedElement(fields, 0), values.providerId);
  setInputValue(requireIndexedElement(fields, 1), values.name);
  setInputValue(requireIndexedElement(fields, 2), values.baseUrl);
  setInputValue(requireIndexedElement(fields, 3), values.apiKey);
  setInputValue(requireIndexedElement(modelFields, 0), values.modelId);
  setInputValue(requireIndexedElement(modelFields, 1), values.modelName);
  if (values.headerKey && values.headerValue) {
    setInputValue(requireIndexedElement(modelFields, 2), values.headerKey);
    setInputValue(requireIndexedElement(modelFields, 3), values.headerValue);
  }
  requireElement<HTMLFormElement>(host, '.custom-provider-form').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
  await flushUi();
}

function requireIndexedElement<T extends Element>(elements: NodeListOf<T>, index: number) {
  const element = elements.item(index);
  if (!element) throw new Error(`Missing indexed element: ${index}`);
  return element;
}

beforeEach(() => {
  registryMock.getAdapter.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.app.unmount();
    entry.host.remove();
  }
  HTMLDialogElement.prototype.showModal = dialogMethods.showModal;
  HTMLDialogElement.prototype.close = dialogMethods.close;
});
