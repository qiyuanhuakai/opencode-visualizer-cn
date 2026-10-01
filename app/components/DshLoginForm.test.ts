import { createApp, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import zhCN from '../locales/zh-CN';
import type { DshLoginCredentials, DshLoginError } from './DshLoginForm.vue';
import DshLoginForm from './DshLoginForm.vue';

const mountedApps: Array<() => void> = [];

/** A real `LocaleMessages`-shaped object satisfies createI18n's message map. */
function i18nFor(locale: 'en' | 'zh-CN', messages: typeof en | typeof zhCN) {
  return createI18n({ legacy: false, locale, messages: { [locale]: messages } });
}

type SaveDshMock = ReturnType<typeof vi.fn<(url: string, token: string) => void>>;

type CredentialsStub = DshLoginCredentials & {
  dshBridgeUrl: ReturnType<typeof ref>;
  dshBridgeToken: ReturnType<typeof ref>;
  backendKind: ReturnType<typeof ref>;
  saveDsh: SaveDshMock;
};

function makeCredentials(url: string, token: string): CredentialsStub {
  return {
    dshBridgeUrl: ref(url),
    dshBridgeToken: ref(token),
    backendKind: ref<'opencode' | 'codex' | 'acp' | 'kimi-web' | 'dsh'>('dsh'),
    saveDsh: vi.fn<(url: string, token: string) => void>(),
  };
}

async function setup(
  locale: 'en' | 'zh-CN',
  credentials: CredentialsStub,
  handlers: { error?: DshLoginError } = {},
) {
  const messages = locale === 'en' ? en : zhCN;
  const root = document.createElement('div');
  document.body.append(root);
  const i18n = i18nFor(locale, messages);
  const app = createApp(DshLoginForm, {
    credentials,
    error: '',
    ...handlers,
  });
  app.use(i18n);
  app.mount(root);
  mountedApps.push(() => {
    app.unmount();
    root.remove();
  });
  await nextTick();
  return { root, i18n };
}

/** The five dsh error copies the form can render (mirrors the locale type). */
const DSH_ERROR_KEYS = [
  'bridgeUrlRequired',
  'missingCredential',
  'nativeServicesDisabled',
  'launchTokenMissing',
  'versionMismatch',
] as const;

function connectButton(root: HTMLElement): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) =>
      candidate.textContent?.includes('Connect') || candidate.textContent?.includes('连接'),
  );
  if (!button) throw new Error('Connect button not found');
  return button;
}

function setInput(root: HTMLElement, name: string, value: string) {
  const input = root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`Input ${name} not found`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  vi.restoreAllMocks();
});

describe('DSH login form', () => {
  it('renders exactly two credential fields — bridge URL and bridge token only, with no API-key field', async () => {
    const { root } = await setup('en', makeCredentials('ws://localhost:23004/dsh/ws', ''));

    const inputs = Array.from(root.querySelectorAll('input'));
    expect(inputs.map((input) => input.getAttribute('name'))).toEqual([
      'dshBridgeUrl',
      'dshBridgeToken',
    ]);

    // No API-key field anywhere in the rendered form (dsh credentials are injected locally).
    const serialized = root.innerHTML.toLowerCase();
    expect(serialized).not.toContain('apikey');
    expect(serialized).not.toContain('api-key');
    expect(serialized).not.toContain('api key');
    expect(root.textContent).not.toContain('DEEPSEEK_API_KEY');
  });

  it('shows the DSH bridge hint telling the user the bridge owns the credentials', async () => {
    const { root } = await setup('en', makeCredentials('ws://localhost:23004/dsh/ws', ''));
    expect(root.textContent).toContain(
      (en as { app: { login: { dshBridgeHint: string } } }).app.login.dshBridgeHint,
    );
  });

  it('calls saveDsh with the trimmed bridge URL and the raw bridge token', async () => {
    const credentials = makeCredentials('  ws://localhost:23004/dsh/ws  ', '  raw-token  ');
    const { root } = await setup('en', credentials);

    setInput(root, 'dshBridgeUrl', '  ws://127.0.0.1:23004/dsh/ws  ');
    setInput(root, 'dshBridgeToken', '  raw-token  ');
    await nextTick();

    connectButton(root).click();
    await nextTick();

    expect(credentials.saveDsh).toHaveBeenCalledTimes(1);
    expect(credentials.saveDsh).toHaveBeenCalledWith(
      '  ws://127.0.0.1:23004/dsh/ws  '.trim(),
      '  raw-token  ',
    );
  });

  it.each([
    ['missingCredential', 'en'],
    ['nativeServicesDisabled', 'en'],
    ['launchTokenMissing', 'en'],
    ['versionMismatch', 'en'],
    ['missingCredential', 'zh-CN'],
    ['nativeServicesDisabled', 'zh-CN'],
    ['launchTokenMissing', 'zh-CN'],
    ['versionMismatch', 'zh-CN'],
  ] as Array<[DshLoginError, 'en' | 'zh-CN']>)(
    'renders the localized %s copy (%s)',
    async (errorKey, locale) => {
      const { root, i18n } = await setup(
        locale,
        makeCredentials('ws://localhost:23004/dsh/ws', ''),
        {
          error: errorKey,
        },
      );

      const compiled = String(i18n.global.t(`app.login.dshErrors.${errorKey}`));
      expect(compiled.length).toBeGreaterThan(10);
      expect(root.textContent).toContain(compiled);
    },
  );

  it('renders no error copy when the connection error is empty', async () => {
    const { root, i18n } = await setup('en', makeCredentials('ws://localhost:23004/dsh/ws', ''), {
      error: '',
    });
    for (const key of DSH_ERROR_KEYS) {
      const compileable = String(i18n.global.t(`app.login.dshErrors.${key}`));
      expect(compileable.length).toBeGreaterThan(10);
      expect(root.textContent).not.toContain(compileable);
    }
  });

  it('rejects an empty bridge URL without calling saveDsh and shows the localized error', async () => {
    const credentials = makeCredentials('', 'bridge-token');
    const { root } = await setup('en', credentials);

    setInput(root, 'dshBridgeUrl', '   ');
    setInput(root, 'dshBridgeToken', 'bridge-token');
    await nextTick();

    connectButton(root).click();
    await nextTick();

    expect(credentials.saveDsh).not.toHaveBeenCalled();
    expect(root.textContent).toContain(
      (en as { app: { login: { dshErrors: { bridgeUrlRequired: string } } } }).app.login.dshErrors
        .bridgeUrlRequired,
    );
  });

  it('rejects a non-ws/ http(s)-only scheme URL without calling saveDsh', async () => {
    const credentials = makeCredentials('', '');
    const { root } = await setup('en', credentials);

    setInput(root, 'dshBridgeUrl', 'not-a-url');
    setInput(root, 'dshBridgeToken', 'token');
    await nextTick();

    connectButton(root).click();
    await nextTick();

    expect(credentials.saveDsh).not.toHaveBeenCalled();
  });

  it('submits Enter inside either field to connect', async () => {
    const credentials = makeCredentials('ws://localhost:23004/dsh/ws', '');
    const { root } = await setup('en', credentials);

    setInput(root, 'dshBridgeUrl', 'ws://127.0.0.1:23004/dsh/ws');
    setInput(root, 'dshBridgeToken', 'token');
    await nextTick();

    const urlInput = root.querySelector<HTMLInputElement>('input[name="dshBridgeUrl"]');
    urlInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();

    expect(credentials.saveDsh).toHaveBeenCalledTimes(1);
  });
});
