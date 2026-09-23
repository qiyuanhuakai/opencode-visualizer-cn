import { describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  changeCheckbox,
  codexBackend,
  conditionalAuthMethods,
  expandProviderList,
  flushUi,
  mountProviderManager,
  openCodeBackend,
  providerConnectButton,
  requireElement,
  setProviderBackend,
  submitCustomProvider,
} from './providerManagerModal.test-helpers';

describe('ProviderManagerModal integration contracts', () => {
  it('keeps shared model visibility controls available for Kimi Web', async () => {
    setProviderBackend(openCodeBackend());
    const { host, events } = await mountProviderManager({
      backendKind: 'kimi-web',
      providers: [{ id: 'kimi', models: { k3: { id: 'k3' } } }],
      connectedProviderIds: ['kimi'],
    });
    buttonByText(host, 'Model management').click();
    await flushUi();
    changeCheckbox(requireElement<HTMLInputElement>(host, '.model-row .toggle-input'), false);
    expect(events.modelVisibility).toHaveBeenCalledExactlyOnceWith([
      { providerID: 'kimi', modelID: 'k3', visibility: 'hide' },
    ]);
  });

  it('preserves Kimi managed model aliases when hiding models', async () => {
    setProviderBackend(openCodeBackend());
    const { host, events } = await mountProviderManager({
      backendKind: 'kimi-web',
      providers: [{ id: 'managed:kimi-code', models: { 'kimi-code/k3': { id: 'kimi-code/k3' } } }],
      connectedProviderIds: ['managed:kimi-code'],
      selectedModel: 'managed:kimi-code/kimi-code/k3',
    });
    buttonByText(host, 'Model management').click();
    await flushUi();
    expect(host.querySelector('.model-row')?.classList.contains('is-selected')).toBe(true);
    changeCheckbox(requireElement<HTMLInputElement>(host, '.model-row .toggle-input'), false);
    expect(events.modelVisibility).toHaveBeenCalledExactlyOnceWith([
      { providerID: 'managed:kimi-code', modelID: 'kimi-code/k3', visibility: 'hide' },
    ]);
  });
  it('emits model visibility updates with slash-containing model ids intact', async () => {
    const backend = openCodeBackend();
    setProviderBackend(backend);
    const { host, events } = await mountProviderManager({
      providers: [
        { id: 'proxy', name: 'Proxy', models: { 'vendor/model/v1': { id: 'vendor/model/v1' } } },
      ],
      connectedProviderIds: ['proxy'],
      selectedModel: 'proxy/vendor/model/v1',
    });

    buttonByText(host, 'Model management').click();
    await flushUi();
    changeCheckbox(requireElement<HTMLInputElement>(host, '.model-row .toggle-input'), false);

    expect(events.modelVisibility).toHaveBeenCalledExactlyOnceWith([
      { providerID: 'proxy', modelID: 'vendor/model/v1', visibility: 'hide' },
    ]);
  });

  it('keeps provider rows from changing selected models when clicked', async () => {
    const backend = openCodeBackend();
    setProviderBackend(backend);
    const { host, events } = await mountProviderManager({
      providers: [{ id: 'proxy', name: 'Proxy', models: { model: { id: 'model' } } }],
      connectedProviderIds: ['proxy'],
      selectedModel: 'proxy/model',
    });

    await expandProviderList(host);
    requireElement<HTMLElement>(host, '.provider-mini-row').click();

    expect(events.selectModel).not.toHaveBeenCalled();
    expect(events.modelVisibility).not.toHaveBeenCalled();
  });

  it('keeps connect actionable when provider auth metadata is absent', async () => {
    const backend = openCodeBackend({ orphan: [] });
    setProviderBackend(backend);
    const showPrompt = vi.fn(async () => ' sk-opencode ');
    const { host, events } = await mountProviderManager({
      providers: [{ id: 'orphan', name: 'Orphan AI', models: {} }],
      showPrompt,
    });

    await expandProviderList(host);
    const connect = providerConnectButton(host, 'orphan');
    expect(connect.disabled).toBe(false);
    connect.click();
    await flushUi();

    expect(backend.setProviderAuth).toHaveBeenCalledExactlyOnceWith('orphan', {
      type: 'api',
      key: 'sk-opencode',
    });
    expect(events.providersChanged).toHaveBeenCalledOnce();
  });

  it('honors eq and neq conditional auth prompts before OAuth authorization', async () => {
    const backend = openCodeBackend(conditionalAuthMethods());
    setProviderBackend(backend);
    const answers = ['1', 'tenant-eu', 'keep-global'];
    const showPrompt = vi.fn(async () => answers.shift() ?? null);
    const { host, events, setOpen } = await mountProviderManager({
      backendKind: 'opencode',
      providers: [{ id: 'oauthy', name: 'OAuthy', models: {} }],
      showPrompt,
    });
    await setOpen(true);

    await expandProviderList(host);
    providerConnectButton(host, 'oauthy').click();
    await flushUi();

    expect(showPrompt).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(backend.authorizeProviderOAuth).toHaveBeenCalledOnce());
    expect(backend.authorizeProviderOAuth).toHaveBeenCalledExactlyOnceWith('oauthy', {
      method: 0,
      inputs: { region: 'eu', tenant: 'tenant-eu', notUs: 'keep-global' },
    });
    expect(backend.completeProviderOAuth).toHaveBeenCalledExactlyOnceWith('oauthy', { method: 0 });
    expect(events.providersChanged).toHaveBeenCalledOnce();
  });

  it('omits neq auth prompts when the selected value matches the neq condition', async () => {
    const backend = openCodeBackend(conditionalAuthMethods());
    setProviderBackend(backend);
    const answers = ['2', 'only-us'];
    const showPrompt = vi.fn(async () => answers.shift() ?? null);
    const { host, setOpen } = await mountProviderManager({
      backendKind: 'opencode',
      providers: [{ id: 'oauthy', name: 'OAuthy', models: {} }],
      showPrompt,
    });
    await setOpen(true);

    await expandProviderList(host);
    providerConnectButton(host, 'oauthy').click();
    await flushUi();

    expect(showPrompt).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(backend.authorizeProviderOAuth).toHaveBeenCalledOnce());
    expect(backend.authorizeProviderOAuth).toHaveBeenCalledExactlyOnceWith('oauthy', {
      method: 0,
      inputs: { region: 'us', usOnly: 'only-us' },
    });
  });

  it('persists OpenCode custom providers through auth and config payloads', async () => {
    const backend = openCodeBackend();
    setProviderBackend(backend);
    const { host, events } = await mountProviderManager({
      providerConfig: {
        enabled_providers: ['baseline'],
        disabled_providers: ['proxyhub'],
        provider: { existing: { name: 'Existing' } },
      },
    });

    await submitCustomProvider(host, {
      providerId: 'proxyhub',
      name: 'Proxy Hub',
      baseUrl: 'https://proxy.example/v1',
      apiKey: 'sk-proxy',
      modelId: 'vendor/model/v1',
      modelName: 'Vendor Model',
    });

    expect(backend.setProviderAuth).toHaveBeenCalledExactlyOnceWith('proxyhub', {
      type: 'api',
      key: 'sk-proxy',
    });
    expect(backend.updateGlobalConfig).toHaveBeenCalledExactlyOnceWith({
      provider: {
        existing: { name: 'Existing' },
        proxyhub: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Proxy Hub',
          options: { baseURL: 'https://proxy.example/v1' },
          models: { 'vendor/model/v1': { name: 'Vendor Model' } },
        },
      },
      disabled_providers: [],
      enabled_providers: ['baseline', 'proxyhub'],
    });
    expect(events.configUpdated).toHaveBeenCalledExactlyOnceWith({
      provider: expect.objectContaining({ proxyhub: expect.any(Object) }),
      disabled_providers: [],
      enabled_providers: ['baseline', 'proxyhub'],
    });
    expect(events.providersChanged).toHaveBeenCalledOnce();
  });

  it('persists Codex custom providers through config only', async () => {
    const backend = codexBackend();
    setProviderBackend(backend);
    const { host, events } = await mountProviderManager({
      backendKind: 'codex',
      providerConfig: { enabled_providers: ['openai'], disabled_providers: ['proxyhub'] },
    });

    await submitCustomProvider(host, {
      providerId: 'proxyhub',
      name: 'Proxy Hub',
      baseUrl: 'https://proxy.example/v1',
      apiKey: '{env:PROXY_API_KEY}',
      modelId: 'vendor/model/v1',
      modelName: 'Vendor Model',
      headerKey: 'X-Provider',
      headerValue: 'proxyhub',
    });

    expect(backend.updateGlobalConfig).toHaveBeenCalledExactlyOnceWith({
      'model_providers.proxyhub': {
        name: 'Proxy Hub',
        base_url: 'https://proxy.example/v1',
        wire_api: 'responses',
        env_key: 'PROXY_API_KEY',
        http_headers: { 'X-Provider': 'proxyhub' },
        models: { 'vendor/model/v1': { name: 'Vendor Model' } },
      },
      'vis.model_providers.proxyhub': {
        models: { 'vendor/model/v1': { name: 'Vendor Model' } },
      },
      disabled_providers: [],
      enabled_providers: ['openai', 'proxyhub'],
    });
    expect(events.configUpdated).toHaveBeenCalledOnce();
    expect(events.providersChanged).toHaveBeenCalledOnce();
  });

  it('persists config-backed provider disconnects', async () => {
    const backend = openCodeBackend();
    setProviderBackend(backend);
    const showConfirm = vi.fn(async () => true);
    const { host, events } = await mountProviderManager({
      providers: [{ id: 'proxyhub', name: 'Proxy Hub', source: 'custom', models: {} }],
      connectedProviderIds: ['proxyhub'],
      providerConfig: {
        enabled_providers: ['proxyhub'],
        provider: { proxyhub: { name: 'Proxy Hub' } },
      },
      showConfirm,
    });

    buttonByText(host, 'Disconnect').click();
    await flushUi();

    expect(showConfirm).toHaveBeenCalledOnce();
    expect(backend.deleteProviderAuth).toHaveBeenCalledExactlyOnceWith('proxyhub');
    expect(backend.updateGlobalConfig).toHaveBeenCalledExactlyOnceWith({
      disabled_providers: ['proxyhub'],
    });
    expect(events.configUpdated).toHaveBeenCalledExactlyOnceWith({
      disabled_providers: ['proxyhub'],
    });
    expect(events.providersChanged).toHaveBeenCalledOnce();
  });
});
