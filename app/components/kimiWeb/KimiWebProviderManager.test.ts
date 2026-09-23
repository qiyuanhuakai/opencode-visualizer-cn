import { createApp, nextTick, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locales/en';
import { createKimiWebProvidersClient } from '../../composables/useKimiWebProviders';
import KimiWebProviderManager from './KimiWebProviderManager.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ app, host }) => {
    app.unmount();
    host.remove();
  });
  document.body.innerHTML = '';
});

function envelope(data: unknown, code = 0, msg = 'success') {
  return { code, msg, data, request_id: 'req-1' };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type RouteHandler = () => Response | Promise<Response>;

function createTestClient() {
  const handlers = new Map<string, RouteHandler>();
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(href);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url: href,
      body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
    });
    const handler = handlers.get(`${method} ${parsed.pathname}`);
    if (!handler) throw new Error(`Unrouted request: ${method} ${parsed.pathname}`);
    return handler();
  });
  const client = createKimiWebProvidersClient({
    bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
    fetcher,
  });
  return {
    calls,
    route(method: string, path: string, handler: RouteHandler) {
      handlers.set(`${method} ${path}`, handler);
    },
    client,
  };
}

const MANAGED_PROVIDER = {
  id: 'managed:kimi-code',
  type: 'kimi',
  has_api_key: true,
  status: 'connected',
  default_model: 'managed:kimi-code/k3',
  models: ['managed:kimi-code/k3'],
};

const OPENAI_PROVIDER = {
  id: 'custom-openai',
  type: 'openai',
  base_url: 'https://api.example.com/v1',
  default_model: 'custom-openai/gpt-4.1',
  has_api_key: true,
  status: 'connected',
  models: ['custom-openai/gpt-4.1', 'custom-openai/gpt-4.1-mini'],
};

const ANTHROPIC_PROVIDER = {
  id: 'custom-anthropic',
  type: 'anthropic',
  base_url: 'https://api.anthropic.com/v1',
  has_api_key: false,
  status: 'unconfigured',
  models: [],
};

const CONFIG_MODELS: Record<string, unknown> = {
  'managed:kimi-code/k3': {
    model: 'k3',
    name: 'Kimi K3',
    max_context_size: 131_072,
    capabilities: ['tools'],
  },
  'custom-openai/gpt-4.1': {
    model: 'gpt-4.1',
    name: 'GPT 4.1',
    max_context_size: 128_000,
    capabilities: ['tool_use'],
  },
  'custom-openai/gpt-4.1-mini': {
    model: 'gpt-4.1-mini',
    name: 'GPT 4.1 mini',
    max_context_size: 32_000,
    capabilities: ['vision', 'thinking'],
  },
};

function routeProviderList(harness: ReturnType<typeof createTestClient>, items: unknown[]) {
  harness.route('GET', '/kimi-web/api/v1/providers', () => jsonResponse(envelope({ items })));
  harness.route('GET', '/kimi-web/api/v1/config', () =>
    jsonResponse(envelope({ models: CONFIG_MODELS })),
  );
  harness.route('GET', '/kimi-web/api/v1/catalog/providers', () =>
    jsonResponse(envelope({ items: [] })),
  );
}

async function flushUi() {
  await nextTick();
  // A macrotask boundary drains the whole await chain (write + reload).
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountManager(
  setupRoutes: (harness: ReturnType<typeof createTestClient>) => void,
  options: { confirmResult?: () => boolean } = {},
) {
  const harness = createTestClient();
  setupRoutes(harness);
  const showConfirm = vi.fn(async () => options.confirmResult?.() ?? true);
  const host = document.createElement('div');
  document.body.append(host);
  const providersChanged = vi.fn();
  const app = createApp(KimiWebProviderManager, {
    client: harness.client,
    onProvidersChanged: providersChanged,
  });
  app.use(
    createI18n({
      legacy: false,
      locale: 'en',
      missingWarn: false,
      fallbackWarn: false,
      messages: { en },
    }),
  );
  app.provide('showConfirm', showConfirm);
  app.mount(host);
  mountedApps.push({ app, host });
  await flushUi();
  return { harness, host, showConfirm, providersChanged };
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function chooseRadio(input: HTMLInputElement) {
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function submitForm(host: HTMLElement) {
  host
    .querySelector<HTMLFormElement>('.kimi-web-provider-form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function buttonByText(root: ParentNode, text: string) {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

function cardByProviderId(host: HTMLElement, providerId: string) {
  const card = host.querySelector<HTMLElement>(`[data-provider-id="${providerId}"]`);
  if (!card) throw new Error(`Missing provider card: ${providerId}`);
  return card;
}

describe('KimiWebProviderManager', () => {
  it('keeps model details collapsed while leaving provider actions accessible', async () => {
    const { host } = await mountManager((harness) => routeProviderList(harness, [OPENAI_PROVIDER]));
    const card = cardByProviderId(host, OPENAI_PROVIDER.id);
    const details = card.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toContain('2');
    expect(card.querySelector('.kimi-web-provider-card-actions')?.closest('details')).toBeNull();
    if (!details) throw new Error('Missing model disclosure');
    details.open = true;
    expect(details.querySelectorAll('.kimi-web-provider-model')).toHaveLength(2);
  });
  it('notifies the shared model picker after changing the default', async () => {
    const { host, providersChanged } = await mountManager((harness) => {
      routeProviderList(harness, [OPENAI_PROVIDER]);
      harness.route('POST', '/kimi-web/api/v1/models/custom-openai%2Fgpt-4.1:set_default', () =>
        jsonResponse(envelope({})),
      );
    });
    buttonByText(host, en.kimiWeb.providers.setDefault).click();
    await flushUi();
    expect(providersChanged).toHaveBeenCalledOnce();
  });
  it('renders provider status key state base url and default model', async () => {
    const { host } = await mountManager((harness) =>
      routeProviderList(harness, [MANAGED_PROVIDER, OPENAI_PROVIDER, ANTHROPIC_PROVIDER]),
    );

    const openai = cardByProviderId(host, 'custom-openai');
    expect(openai.querySelector('.kimi-web-provider-name')?.textContent).toBe('custom-openai');
    expect(openai.querySelector('.kimi-web-provider-id')?.textContent).toBe('custom-openai');
    expect(openai.querySelector('.kimi-web-provider-badge.is-type')?.textContent).toBe('openai');
    expect(openai.querySelector('.kimi-web-provider-badge.is-status')?.textContent).toBe(
      'connected',
    );
    expect(openai.querySelector('.kimi-web-provider-badge.is-status')?.className).toContain(
      'is-connected',
    );
    expect(openai.querySelector('.kimi-web-provider-meta-base-url')?.textContent).toContain(
      'https://api.example.com/v1',
    );
    expect(openai.querySelector('.kimi-web-provider-meta-key')?.textContent).toBe(
      en.kimiWeb.providers.keyConfigured,
    );
    expect(openai.querySelector('.kimi-web-provider-meta-default')?.textContent).toContain(
      'custom-openai/gpt-4.1',
    );

    const anthropic = cardByProviderId(host, 'custom-anthropic');
    expect(anthropic.querySelector('.kimi-web-provider-badge.is-status')?.textContent).toBe(
      'unconfigured',
    );
    expect(anthropic.querySelector('.kimi-web-provider-badge.is-status')?.className).toContain(
      'is-unconfigured',
    );
    expect(anthropic.querySelector('.kimi-web-provider-meta-key')?.textContent).toBe(
      en.kimiWeb.providers.keyMissing,
    );
    expect(anthropic.querySelector('.kimi-web-provider-meta-default')).toBeNull();
  });

  it('renders models with context size and capability badges', async () => {
    const { host } = await mountManager((harness) => routeProviderList(harness, [OPENAI_PROVIDER]));

    const card = cardByProviderId(host, 'custom-openai');
    const model = card.querySelector<HTMLElement>('[data-model-id="gpt-4.1"]');
    expect(model?.querySelector('.kimi-web-provider-model-name')?.textContent).toBe('GPT 4.1');
    expect(model?.querySelector('.kimi-web-provider-model-id')?.textContent).toBe(
      'custom-openai/gpt-4.1',
    );
    expect(model?.querySelector('.kimi-web-provider-model-context')?.textContent).toContain('128K');
    expect(model?.querySelector('[data-capability="toolcall"]')?.textContent).toBe('toolcall');

    const mini = card.querySelector<HTMLElement>('[data-model-id="gpt-4.1-mini"]');
    expect(mini?.querySelector('.kimi-web-provider-model-context')?.textContent).toContain('32K');
    expect(
      Array.from(mini?.querySelectorAll('[data-capability]') ?? []).map((badge) =>
        badge.getAttribute('data-capability'),
      ),
    ).toEqual(['attachment', 'reasoning']);
  });

  it('disables only the busy provider actions', async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host, harness } = await mountManager((harness) => {
      routeProviderList(harness, [OPENAI_PROVIDER, ANTHROPIC_PROVIDER]);
      harness.route('POST', '/kimi-web/api/v1/providers/custom-openai:refresh', async () => {
        await gate;
        return jsonResponse(envelope({ changed: [], unchanged: [], failed: [] }));
      });
    });

    buttonByText(cardByProviderId(host, 'custom-openai'), en.kimiWeb.providers.refresh).click();
    await flushUi();

    const busyCard = cardByProviderId(host, 'custom-openai');
    const idleCard = cardByProviderId(host, 'custom-anthropic');
    expect(busyCard.getAttribute('aria-busy')).toBe('true');
    expect(
      Array.from(busyCard.querySelectorAll<HTMLButtonElement>('.kimi-web-provider-action')).every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    expect(
      Array.from(idleCard.querySelectorAll<HTMLButtonElement>('.kimi-web-provider-action')).every(
        (button) => button.disabled,
      ),
    ).toBe(false);
    expect(harness.calls.some((call) => call.url.endsWith('custom-openai:refresh'))).toBe(true);

    release();
    await flushUi();

    expect(
      Array.from(
        cardByProviderId(host, 'custom-openai').querySelectorAll<HTMLButtonElement>(
          '.kimi-web-provider-action',
        ),
      ).every((button) => button.disabled),
    ).toBe(false);
  });

  it('confirms before delete', async () => {
    let confirmed = false;
    const { host, harness, showConfirm } = await mountManager(
      (harness) => {
        routeProviderList(harness, [OPENAI_PROVIDER, ANTHROPIC_PROVIDER]);
        harness.route(
          'DELETE',
          '/kimi-web/api/v1/providers/custom-openai',
          () => new Response(null, { status: 204 }),
        );
      },
      { confirmResult: () => confirmed },
    );

    buttonByText(cardByProviderId(host, 'custom-openai'), en.kimiWeb.providers.delete).click();
    await flushUi();

    expect(showConfirm).toHaveBeenCalledWith(en.kimiWeb.providers.deleteConfirm);
    expect(harness.calls.some((call) => call.method === 'DELETE')).toBe(false);

    confirmed = true;
    buttonByText(cardByProviderId(host, 'custom-openai'), en.kimiWeb.providers.delete).click();
    await flushUi();

    expect(showConfirm).toHaveBeenCalledTimes(2);
    expect(harness.calls.some((call) => call.method === 'DELETE')).toBe(true);
  });

  it('connects only the chosen catalog provider through a prefilled form', async () => {
    const { host, harness } = await mountManager((harness) => {
      routeProviderList(harness, [OPENAI_PROVIDER]);
      harness.route('GET', '/kimi-web/api/v1/catalog/providers', () =>
        jsonResponse(
          envelope({
            items: [
              {
                id: 'openrouter',
                name: 'OpenRouter',
                env_key: 'OPENROUTER_API_KEY',
                wire_type: 'openai',
                base_url: 'https://openrouter.ai/api/v1',
                rejected: false,
                needs_base_url: false,
                models: [{ id: 'gpt-4.1', max_context_size: 128_000 }],
              },
            ],
          }),
        ),
      );
      harness.route(
        'POST',
        '/kimi-web/api/v1/providers:import_catalog',
        () => new Response(null, { status: 200 }),
      );
    });

    const entry = host.querySelector<HTMLElement>('[data-catalog-id="openrouter"]');
    expect(entry?.querySelector('.kimi-web-provider-catalog-name')?.textContent).toBe('OpenRouter');
    expect(entry?.querySelector('.kimi-web-provider-catalog-env')?.textContent).toContain(
      'OPENROUTER_API_KEY',
    );

    buttonByText(entry as ParentNode, en.providerManager.actions.connect).click();
    await flushUi();

    expect(host.querySelector('.kimi-web-provider-catalog')).toBeNull();
    expect(host.querySelector('.kimi-web-provider-list')).toBeNull();
    expect(host.querySelector('.kimi-web-provider-form')).toBeTruthy();

    expect(
      harness.calls.some(
        (call) => call.method === 'POST' && call.url.endsWith('/api/v1/providers:import_catalog'),
      ),
    ).toBe(false);
    expect(host.querySelector<HTMLInputElement>('.kimi-web-provider-field input')?.value).toBe(
      'openrouter',
    );
    expect(host.querySelector<HTMLInputElement>('.kimi-web-provider-model-row input')?.value).toBe(
      'gpt-4.1',
    );
  });

  it('is keyboard operable and exposes accessible names', async () => {
    const { host } = await mountManager((harness) => routeProviderList(harness, [OPENAI_PROVIDER]));

    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      const name =
        button.getAttribute('aria-label')?.trim() ||
        button.getAttribute('title')?.trim() ||
        button.textContent?.trim();
      expect(name).toBeTruthy();
    }

    const edit = buttonByText(host, en.kimiWeb.providers.edit);
    edit.focus();
    expect(document.activeElement).toBe(edit);
    edit.click();
    await flushUi();

    const form = host.querySelector<HTMLFormElement>('.kimi-web-provider-form');
    expect(form).toBeTruthy();
    const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit?.textContent?.trim()).toBe(en.kimiWeb.providers.save);
    submit?.focus();
    expect(document.activeElement).toBe(submit);
    for (const input of Array.from(form?.querySelectorAll<HTMLInputElement>('input') ?? [])) {
      const label = input.getAttribute('aria-label') ?? input.closest('label')?.textContent ?? '';
      expect(label.trim()).toBeTruthy();
    }
  });

  it('marks the managed provider as server-managed and read-only', async () => {
    const { host } = await mountManager((harness) =>
      routeProviderList(harness, [MANAGED_PROVIDER, OPENAI_PROVIDER]),
    );

    const managed = cardByProviderId(host, 'managed:kimi-code');
    const badge = managed.querySelector('.kimi-web-provider-badge.is-managed');
    expect(badge?.textContent).toBe(en.kimiWeb.providers.managed);
    expect(badge?.getAttribute('title')).toBe(en.kimiWeb.providers.managedReadOnly);
    expect(buttonByText(managed, en.kimiWeb.providers.edit).disabled).toBe(true);
    expect(buttonByText(managed, en.kimiWeb.providers.delete).disabled).toBe(true);
    expect(
      buttonByText(cardByProviderId(host, 'custom-openai'), en.kimiWeb.providers.edit).disabled,
    ).toBe(false);
  });

  it('saves an edit without sending a key and preserves capabilities on the wire', async () => {
    const { host, harness } = await mountManager((harness) => {
      routeProviderList(harness, [OPENAI_PROVIDER]);
      harness.route('PUT', '/kimi-web/api/v1/providers/custom-openai', () =>
        jsonResponse(envelope({ id: 'custom-openai' })),
      );
    });

    buttonByText(cardByProviderId(host, 'custom-openai'), en.kimiWeb.providers.edit).click();
    await flushUi();

    const form = host.querySelector<HTMLFormElement>('.kimi-web-provider-form');
    const idInput = form?.querySelector<HTMLInputElement>('input[type="text"]');
    expect(idInput?.value).toBe('custom-openai');
    expect(idInput?.disabled).toBe(true);
    expect(form?.querySelector<HTMLSelectElement>('select')?.value).toBe('openai');
    expect(
      Array.from(
        form?.querySelectorAll<HTMLInputElement>('.kimi-web-provider-model-row input') ?? [],
      )
        .slice(0, 6)
        .map((input) => input.value),
    ).toEqual(['gpt-4.1', 'GPT 4.1', '128000', 'gpt-4.1-mini', 'GPT 4.1 mini', '32000']);

    submitForm(host);
    await flushUi();

    const put = harness.calls.filter((call) => call.method === 'PUT').at(-1);
    expect(put?.url).toBe('http://localhost:23004/kimi-web/api/v1/providers/custom-openai');
    expect(put?.body).toEqual({
      type: 'openai',
      base_url: 'https://api.example.com/v1',
      models: [
        {
          model: 'gpt-4.1',
          display_name: 'GPT 4.1',
          max_context_size: 128_000,
          capabilities: ['tool_use'],
        },
        {
          model: 'gpt-4.1-mini',
          display_name: 'GPT 4.1 mini',
          max_context_size: 32_000,
          capabilities: ['vision', 'thinking'],
        },
      ],
    });
    expect(host.querySelector('.kimi-web-provider-feedback')?.textContent).toBe(
      en.kimiWeb.providers.saved,
    );
  });

  it('creates a provider with snake_case model fields and no key when none was entered', async () => {
    const { host, harness } = await mountManager((harness) => {
      routeProviderList(harness, [OPENAI_PROVIDER]);
      harness.route('POST', '/kimi-web/api/v1/providers', () =>
        jsonResponse(envelope({ id: 'custom-anthropic' })),
      );
    });

    buttonByText(host, en.kimiWeb.providers.add).click();
    await flushUi();

    const form = host.querySelector<HTMLFormElement>('.kimi-web-provider-form');
    const inputs = Array.from(form?.querySelectorAll<HTMLInputElement>('input') ?? []);
    setInputValue(inputs[0], 'custom-anthropic');
    setSelectValue(
      form?.querySelector<HTMLSelectElement>('select') as HTMLSelectElement,
      'anthropic',
    );
    const modelInputs = Array.from(
      form?.querySelectorAll<HTMLInputElement>('.kimi-web-provider-model-row input') ?? [],
    );
    setInputValue(modelInputs[0], 'claude-sonnet-4');
    setInputValue(modelInputs[1], 'Claude Sonnet 4');
    setInputValue(modelInputs[2], '200000');

    submitForm(host);
    await flushUi();

    const post = harness.calls.filter((call) => call.method === 'POST').at(-1);
    expect(post?.url).toBe('http://localhost:23004/kimi-web/api/v1/providers');
    expect(post?.body).toEqual({
      id: 'custom-anthropic',
      type: 'anthropic',
      models: [
        { model: 'claude-sonnet-4', display_name: 'Claude Sonnet 4', max_context_size: 200_000 },
      ],
    });
    expect(post?.body).not.toHaveProperty('api_key');
    expect(host.querySelector('.kimi-web-provider-form')).toBeNull();
  });

  it('suggests updating instead of creating when the id already exists', async () => {
    const { host, harness } = await mountManager((harness) => {
      routeProviderList(harness, [OPENAI_PROVIDER]);
      harness.route('POST', '/kimi-web/api/v1/providers', () =>
        jsonResponse(envelope(null, 40921, 'provider custom-openai already exists')),
      );
    });

    buttonByText(host, en.kimiWeb.providers.add).click();
    await flushUi();
    const form = host.querySelector<HTMLFormElement>('.kimi-web-provider-form');
    const inputs = Array.from(form?.querySelectorAll<HTMLInputElement>('input') ?? []);
    setInputValue(inputs[0], 'custom-openai');
    const modelInputs = Array.from(
      form?.querySelectorAll<HTMLInputElement>('.kimi-web-provider-model-row input') ?? [],
    );
    setInputValue(modelInputs[0], 'gpt-4.1');
    setInputValue(modelInputs[1], 'GPT 4.1');
    setInputValue(modelInputs[2], '128000');
    submitForm(host);
    await flushUi();

    const feedback = host.querySelector('.kimi-web-provider-feedback');
    expect(feedback?.getAttribute('data-error-kind')).toBe('conflict');
    expect(feedback?.textContent).toBe(en.kimiWeb.providers.duplicateId);
    // The form stays open so the user can switch to the update path.
    expect(host.querySelector('.kimi-web-provider-form')).toBeTruthy();
    expect(harness.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('distinguishes a transport failure from a business error', async () => {
    const transport = await mountManager((harness) => {
      harness.route('GET', '/kimi-web/api/v1/providers', () => {
        throw new TypeError('Failed to fetch');
      });
    });
    const transportFeedback = transport.host.querySelector('.kimi-web-provider-feedback');
    expect(transportFeedback?.getAttribute('data-error-kind')).toBe('transport');
    expect(transportFeedback?.textContent).toBe(en.kimiWeb.providers.loadFailed);

    const business = await mountManager((harness) => {
      harness.route('GET', '/kimi-web/api/v1/providers', () =>
        jsonResponse(envelope(null, 40001, 'models are required')),
      );
    });
    const businessFeedback = business.host.querySelector('.kimi-web-provider-feedback');
    expect(businessFeedback?.getAttribute('data-error-kind')).toBe('business');
    expect(businessFeedback?.textContent).toBe('models are required');
  });

  it('never clears the key when the replace field is left empty', async () => {
    const { host, harness } = await mountManager((harness) => {
      routeProviderList(harness, [OPENAI_PROVIDER]);
      harness.route('PUT', '/kimi-web/api/v1/providers/custom-openai', () =>
        jsonResponse(envelope({ id: 'custom-openai' })),
      );
    });

    buttonByText(cardByProviderId(host, 'custom-openai'), en.kimiWeb.providers.edit).click();
    await flushUi();

    const replaceRadio = Array.from(
      host.querySelectorAll<HTMLInputElement>('.kimi-web-provider-form input[type="radio"]'),
    ).find((input) => input.value === 'replace');
    chooseRadio(replaceRadio as HTMLInputElement);
    submitForm(host);
    await flushUi();

    const put = harness.calls.filter((call) => call.method === 'PUT').at(-1);
    expect(put?.body).not.toHaveProperty('api_key');
    expect(host.querySelector('.kimi-web-provider-feedback')?.textContent).toBe(
      en.kimiWeb.providers.saved,
    );
  });

  it('confirms before removing a configured key', async () => {
    let confirmed = false;
    const { host, harness, showConfirm } = await mountManager(
      (harness) => {
        routeProviderList(harness, [OPENAI_PROVIDER]);
        harness.route('PUT', '/kimi-web/api/v1/providers/custom-openai', () =>
          jsonResponse(envelope({ id: 'custom-openai' })),
        );
      },
      { confirmResult: () => confirmed },
    );

    buttonByText(cardByProviderId(host, 'custom-openai'), en.kimiWeb.providers.edit).click();
    await flushUi();

    const removeRadio = Array.from(
      host.querySelectorAll<HTMLInputElement>('.kimi-web-provider-form input[type="radio"]'),
    ).find((input) => input.value === 'remove');
    chooseRadio(removeRadio as HTMLInputElement);
    submitForm(host);
    await flushUi();

    expect(showConfirm).toHaveBeenCalledWith(en.kimiWeb.providers.removeKeyConfirm);
    expect(harness.calls.some((call) => call.method === 'PUT')).toBe(false);

    confirmed = true;
    submitForm(host);
    await flushUi();

    const put = harness.calls.filter((call) => call.method === 'PUT').at(-1);
    expect(put?.body).toMatchObject({ type: 'openai', api_key: '' });
  });
});
