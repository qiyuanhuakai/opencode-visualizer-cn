import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountCodexApp, mountLoginApp } from './test/appHarness';
import { StorageKeys, storageKey } from './utils/storageKeys';

const mountedApps: Array<{ readonly unmount: () => void }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ unmount }) => unmount());
  window.history.replaceState({}, '', '/');
});

function clickBackend(host: HTMLElement, label: string) {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('.app-login-backend')).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  button?.click();
}

async function fillInput(host: HTMLElement, name: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  expect(input).toBeInstanceOf(HTMLInputElement);
  if (!input) return;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

describe('App backend login isolation', () => {
  it('restores OpenCode selection after logging out of a cold-loaded Codex deep link', async () => {
    window.history.replaceState({}, '', '/?project=codex&session=thread-openai');
    const fixture = await mountCodexApp();
    mountedApps.push(fixture);
    const logout = fixture.readSetupBinding('handleLogout');
    if (typeof logout !== 'function') throw new Error('Logout binding unavailable');
    logout();
    await nextTick();
    clickBackend(fixture.host, 'OpenCode');
    await nextTick();
    await fillInput(fixture.host, 'url', 'http://127.0.0.1:4096');
    fixture.host.querySelector<HTMLButtonElement>('.app-loading-connect')?.click();
    await vi.waitFor(() => {
      expect(fixture.readSetupBinding('initErrorMessage')).toBe('');
      expect(fixture.readSetupBinding('uiInitState')).toBe('ready');
      expect(fixture.readSetupBinding('activeBackendKind')).toBe('opencode');
    });
    expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-b');
    expect(fixture.host.querySelector('.app-error-message')).toBeNull();
  }, 15_000);

  it('Given distinct Codex and ACP tokens entered through one real login form, When Codex is selected and submitted, Then Codex receives only its own token', async () => {
    const codexFixture = await mountLoginApp();
    mountedApps.push(codexFixture);
    codexFixture.configureCodexBackend.mockClear();
    codexFixture.configureAcpBackend.mockClear();

    clickBackend(codexFixture.host, 'Codex');
    await nextTick();
    await fillInput(codexFixture.host, 'codexBridgeToken', 'codex-token-only');
    clickBackend(codexFixture.host, 'ACP');
    await nextTick();
    await fillInput(codexFixture.host, 'acpBridgeToken', 'acp-token-only');
    clickBackend(codexFixture.host, 'Codex');
    await nextTick();

    expect(
      codexFixture.host.querySelector<HTMLInputElement>('input[name="codexBridgeToken"]')?.value,
    ).toBe('codex-token-only');
    clickBackend(codexFixture.host, 'ACP');
    await nextTick();
    expect(
      codexFixture.host.querySelector<HTMLInputElement>('input[name="acpBridgeToken"]')?.value,
    ).toBe('acp-token-only');
    clickBackend(codexFixture.host, 'Codex');
    await nextTick();

    const codexConnect = codexFixture.host.querySelector<HTMLButtonElement>('.app-loading-connect');
    expect(codexConnect).toBeInstanceOf(HTMLButtonElement);
    codexConnect?.click();
    await nextTick();

    expect(codexFixture.configureCodexBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({ bridgeToken: 'codex-token-only' }),
    );
    expect(codexFixture.configureCodexBackend).not.toHaveBeenCalledWith(
      expect.objectContaining({ bridgeToken: 'acp-token-only' }),
    );
  });

  it('Given distinct Codex and ACP tokens entered through one real login form, When ACP is selected and submitted, Then ACP receives only its own token', async () => {
    const acpFixture = await mountLoginApp();
    mountedApps.push(acpFixture);
    acpFixture.configureCodexBackend.mockClear();
    acpFixture.configureAcpBackend.mockClear();
    clickBackend(acpFixture.host, 'Codex');
    await nextTick();
    await fillInput(acpFixture.host, 'codexBridgeToken', 'codex-token-only');
    clickBackend(acpFixture.host, 'ACP');
    await nextTick();
    await fillInput(acpFixture.host, 'acpBridgeToken', 'acp-token-only');

    expect(
      acpFixture.host.querySelector<HTMLInputElement>('input[name="acpBridgeToken"]')?.value,
    ).toBe('acp-token-only');
    clickBackend(acpFixture.host, 'Codex');
    await nextTick();
    expect(
      acpFixture.host.querySelector<HTMLInputElement>('input[name="codexBridgeToken"]')?.value,
    ).toBe('codex-token-only');
    clickBackend(acpFixture.host, 'ACP');
    await nextTick();

    const acpConnect = acpFixture.host.querySelector<HTMLButtonElement>('.app-loading-connect');
    expect(acpConnect).toBeInstanceOf(HTMLButtonElement);
    acpConnect?.click();
    await nextTick();

    expect(acpFixture.configureAcpBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({ bridgeToken: 'acp-token-only', agentId: 'oh-my-pi' }),
    );
    expect(acpFixture.configureAcpBackend).not.toHaveBeenCalledWith(
      expect.objectContaining({ bridgeToken: 'codex-token-only' }),
    );
  });

  it('Given distinct Codex and Kimi Web bridge tokens entered through one real login form, When Kimi Web is selected and submitted, Then Kimi Web receives only its own credentials', async () => {
    const kimiFixture = await mountLoginApp();
    mountedApps.push(kimiFixture);
    kimiFixture.configureCodexBackend.mockClear();
    kimiFixture.configureKimiWebBackend.mockClear();

    clickBackend(kimiFixture.host, 'Codex');
    await nextTick();
    await fillInput(kimiFixture.host, 'codexBridgeToken', 'codex-token-only');
    clickBackend(kimiFixture.host, 'Kimi Web');
    await nextTick();
    await fillInput(kimiFixture.host, 'kimiWebBridgeUrl', 'ws://127.0.0.1:23004/kimi-web/ws');
    await fillInput(kimiFixture.host, 'kimiWebBridgeToken', 'kimi-token-only');
    clickBackend(kimiFixture.host, 'Codex');
    await nextTick();

    expect(
      kimiFixture.host.querySelector<HTMLInputElement>('input[name="codexBridgeToken"]')?.value,
    ).toBe('codex-token-only');
    clickBackend(kimiFixture.host, 'Kimi Web');
    await nextTick();

    expect(
      kimiFixture.host.querySelector<HTMLInputElement>('input[name="kimiWebBridgeToken"]')?.value,
    ).toBe('kimi-token-only');
    expect(
      kimiFixture.host.querySelector<HTMLInputElement>('input[name="kimiWebBridgeUrl"]')?.value,
    ).toBe('ws://127.0.0.1:23004/kimi-web/ws');

    const kimiConnect = kimiFixture.host.querySelector<HTMLButtonElement>('.app-loading-connect');
    expect(kimiConnect).toBeInstanceOf(HTMLButtonElement);
    kimiConnect?.click();
    await nextTick();

    expect(kimiFixture.configureKimiWebBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bridgeUrl: 'ws://127.0.0.1:23004/kimi-web/ws',
        bridgeToken: 'kimi-token-only',
      }),
    );
    expect(kimiFixture.configureKimiWebBackend).not.toHaveBeenCalledWith(
      expect.objectContaining({ bridgeToken: 'codex-token-only' }),
    );
    expect(kimiFixture.configureCodexBackend).not.toHaveBeenCalledWith(
      expect.objectContaining({ bridgeToken: 'kimi-token-only' }),
    );
  });

  it('Given a Kimi Web bridge URL entered on the login form, When the bridge precheck answers 401, Then the app falls back to login with the URL preserved', async () => {
    const kimiFixture = await mountLoginApp();
    mountedApps.push(kimiFixture);
    kimiFixture.configureKimiWebBackend.mockClear();

    clickBackend(kimiFixture.host, 'Kimi Web');
    await nextTick();
    await fillInput(kimiFixture.host, 'kimiWebBridgeUrl', 'ws://127.0.0.1:23004/kimi-web/ws');
    await fillInput(kimiFixture.host, 'kimiWebBridgeToken', 'stale-bridge-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );

    kimiFixture.host.querySelector<HTMLButtonElement>('.app-loading-connect')?.click();

    await vi.waitFor(() => {
      expect(kimiFixture.readSetupBinding('uiInitState')).toBe('login');
    });
    expect(kimiFixture.readSetupBinding('connectionState')).toBe('error');
    expect(String(kimiFixture.readSetupBinding('initErrorMessage'))).toContain('401');
    expect(
      kimiFixture.host.querySelector<HTMLInputElement>('input[name="kimiWebBridgeUrl"]')?.value,
    ).toBe('ws://127.0.0.1:23004/kimi-web/ws');
    expect(
      kimiFixture.host.querySelector<HTMLInputElement>('input[name="kimiWebBridgeToken"]')?.value,
    ).toBe('stale-bridge-token');
  });

  it('Given an emptied Kimi Web bridge URL, When the login form is submitted, Then no Kimi Web backend configuration is attempted', async () => {
    const kimiFixture = await mountLoginApp();
    mountedApps.push(kimiFixture);
    kimiFixture.configureKimiWebBackend.mockClear();

    clickBackend(kimiFixture.host, 'Kimi Web');
    await nextTick();
    await fillInput(kimiFixture.host, 'kimiWebBridgeUrl', '');
    await fillInput(kimiFixture.host, 'kimiWebBridgeToken', '   ');

    kimiFixture.host.querySelector<HTMLButtonElement>('.app-loading-connect')?.click();
    await nextTick();

    expect(kimiFixture.configureKimiWebBackend).not.toHaveBeenCalled();
    expect(kimiFixture.readSetupBinding('uiInitState')).toBe('login');
  });
});

describe('App DSH login surface (Todo 35)', () => {
  it('renders a DSH button in the login backend group beside Kimi Web', async () => {
    const dshFixture = await mountLoginApp();
    mountedApps.push(dshFixture);

    const dshButton = Array.from(
      dshFixture.host.querySelectorAll<HTMLButtonElement>('.app-login-backend'),
    ).find((candidate) => candidate.textContent?.includes('DSH'));

    expect(dshButton).toBeInstanceOf(HTMLButtonElement);
  });

  it('Given the DSH login button selected, When the fields block renders, Then exactly the two DSH bridge fields appear and no other backend fields leak in', async () => {
    const dshFixture = await mountLoginApp();
    mountedApps.push(dshFixture);

    clickBackend(dshFixture.host, 'DSH');
    await nextTick();

    expect(dshFixture.host.querySelector('input[name="dshBridgeUrl"]')).toBeInstanceOf(
      HTMLInputElement,
    );
    expect(dshFixture.host.querySelector('input[name="dshBridgeToken"]')).toBeInstanceOf(
      HTMLInputElement,
    );
    expect(dshFixture.host.querySelector('input[name="kimiWebBridgeUrl"]')).toBeNull();
    expect(dshFixture.host.querySelector('input[name="kimiWebBridgeToken"]')).toBeNull();
    expect(dshFixture.host.querySelector('input[name="codexBridgeUrl"]')).toBeNull();
    expect(dshFixture.host.querySelector('input[name="codexBridgeToken"]')).toBeNull();
    expect(dshFixture.host.querySelector('input[name="acpBridgeUrl"]')).toBeNull();
    expect(dshFixture.host.querySelector('input[name="acpBridgeToken"]')).toBeNull();

    // The "must NOT error" half of the absence contract: selecting dsh is a
    // real supported surface, so no error state may appear.
    expect(dshFixture.host.querySelector('.app-error-message')).toBeNull();
    expect(dshFixture.readSetupBinding('uiInitState')).toBe('login');
  });

  it('shows the DSH login title and hint once DSH is selected', async () => {
    const dshFixture = await mountLoginApp();
    mountedApps.push(dshFixture);

    clickBackend(dshFixture.host, 'DSH');
    await nextTick();

    expect(String(dshFixture.readSetupBinding('loginTitle'))).toBe(
      "Connect to DSH via vis_bridge",
    );
    expect(dshFixture.host.querySelector('.app-login-hint')?.textContent).toContain(
      'DSH',
    );
  });

  it('preserves DSH bridge credentials across backend tab switches (stale-state guard)', async () => {
    const dshFixture = await mountLoginApp();
    mountedApps.push(dshFixture);

    clickBackend(dshFixture.host, 'DSH');
    await nextTick();
    await fillInput(dshFixture.host, 'dshBridgeUrl', 'ws://127.0.0.1:23004/dsh/ws');
    await fillInput(dshFixture.host, 'dshBridgeToken', 'dsh-bridge-token');

    clickBackend(dshFixture.host, 'Codex');
    await nextTick();
    await fillInput(dshFixture.host, 'codexBridgeToken', 'codex-token-only');
    clickBackend(dshFixture.host, 'DSH');
    await nextTick();

    expect(
      dshFixture.host.querySelector<HTMLInputElement>('input[name="dshBridgeUrl"]')?.value,
    ).toBe('ws://127.0.0.1:23004/dsh/ws');
    expect(
      dshFixture.host.querySelector<HTMLInputElement>('input[name="dshBridgeToken"]')?.value,
    ).toBe('dsh-bridge-token');
    expect(dshFixture.readSetupBinding('loginDshBridgeUrl')).toBe('ws://127.0.0.1:23004/dsh/ws');
    expect(dshFixture.readSetupBinding('loginDshBridgeToken')).toBe('dsh-bridge-token');
  });

  it('Given DSH credentials entered through the real login form, When submitted, Then the dsh credentials are persisted for the dsh branch (not another backend)', async () => {
    const dshFixture = await mountLoginApp();
    mountedApps.push(dshFixture);

    clickBackend(dshFixture.host, 'DSH');
    await nextTick();
    await fillInput(dshFixture.host, 'dshBridgeUrl', 'ws://127.0.0.1:23004/dsh/ws');
    await fillInput(dshFixture.host, 'dshBridgeToken', 'dsh-token-only');

    const credentials = dshFixture.readSetupBinding('credentials') as {
      saveDsh: (bridgeUrl: string, bridgeToken: string) => void;
    };
    const saveDsh = vi.spyOn(credentials, 'saveDsh');

    dshFixture.host.querySelector<HTMLButtonElement>('.app-loading-connect')?.click();
    await nextTick();

    expect(saveDsh).toHaveBeenCalledWith('ws://127.0.0.1:23004/dsh/ws', 'dsh-token-only');
    // saveDsh persists StorageKeys.auth.backendKind, so this assertion proves
    // the dsh login branch ran instead of another backend's credentials sink.
    expect(window.localStorage.getItem(storageKey(StorageKeys.auth.backendKind))).toBe('dsh');
  });

  it('Given distinct Codex and DSH bridge credentials entered through one real login form, When DSH is selected and submitted, Then DSH receives only its own credentials', async () => {
    const dshFixture = await mountLoginApp();
    mountedApps.push(dshFixture);
    dshFixture.configureCodexBackend.mockClear();
    dshFixture.configureDshBackend.mockClear();

    clickBackend(dshFixture.host, 'Codex');
    await nextTick();
    await fillInput(dshFixture.host, 'codexBridgeToken', 'codex-token-only');
    clickBackend(dshFixture.host, 'DSH');
    await nextTick();
    await fillInput(dshFixture.host, 'dshBridgeUrl', 'ws://127.0.0.1:23004/dsh/ws');
    await fillInput(dshFixture.host, 'dshBridgeToken', 'dsh-token-only');
    clickBackend(dshFixture.host, 'Codex');
    await nextTick();

    expect(
      dshFixture.host.querySelector<HTMLInputElement>('input[name="codexBridgeToken"]')?.value,
    ).toBe('codex-token-only');
    clickBackend(dshFixture.host, 'DSH');
    await nextTick();

    expect(
      dshFixture.host.querySelector<HTMLInputElement>('input[name="dshBridgeUrl"]')?.value,
    ).toBe('ws://127.0.0.1:23004/dsh/ws');
    expect(
      dshFixture.host.querySelector<HTMLInputElement>('input[name="dshBridgeToken"]')?.value,
    ).toBe('dsh-token-only');

    const dshConnect = dshFixture.host.querySelector<HTMLButtonElement>('.app-loading-connect');
    expect(dshConnect).toBeInstanceOf(HTMLButtonElement);
    dshConnect?.click();
    await nextTick();

    expect(dshFixture.configureDshBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bridgeUrl: 'ws://127.0.0.1:23004/dsh/ws',
        bridgeToken: 'dsh-token-only',
      }),
    );
    expect(dshFixture.configureDshBackend).not.toHaveBeenCalledWith(
      expect.objectContaining({ bridgeToken: 'codex-token-only' }),
    );
    expect(dshFixture.configureCodexBackend).not.toHaveBeenCalledWith(
      expect.objectContaining({ bridgeToken: 'dsh-token-only' }),
    );
  });

  it('Given the DSH login button selected, When the DSH fields block renders, Then the bridge URL field pre-fills the shared default value', async () => {
    const dshFixture = await mountLoginApp();
    mountedApps.push(dshFixture);

    clickBackend(dshFixture.host, 'DSH');
    await nextTick();

    const urlInput = dshFixture.host.querySelector<HTMLInputElement>('input[name="dshBridgeUrl"]');
    expect(urlInput).toBeInstanceOf(HTMLInputElement);
    // Assert the rendered VALUE, not the placeholder: the locale placeholder is
    // `ws://host:23004/dsh/ws`, which differs from the real default host.
    expect(urlInput?.value).toBe('ws://localhost:23004/dsh/ws');
    expect(urlInput?.value).not.toBe(urlInput?.placeholder);
    expect(dshFixture.readSetupBinding('loginDshBridgeUrl')).toBe('ws://localhost:23004/dsh/ws');
  });

  it('Given a DSH bridge URL entered on the login form, When the bridge precheck answers 401, Then the app falls back to login with the URL preserved', async () => {
    const dshFixture = await mountLoginApp();
    mountedApps.push(dshFixture);
    dshFixture.configureDshBackend.mockClear();

    clickBackend(dshFixture.host, 'DSH');
    await nextTick();
    await fillInput(dshFixture.host, 'dshBridgeUrl', 'ws://127.0.0.1:23004/dsh/ws');
    await fillInput(dshFixture.host, 'dshBridgeToken', 'stale-bridge-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );

    dshFixture.host.querySelector<HTMLButtonElement>('.app-loading-connect')?.click();

    await vi.waitFor(() => {
      expect(dshFixture.readSetupBinding('uiInitState')).toBe('login');
    });
    expect(dshFixture.readSetupBinding('connectionState')).toBe('error');
    expect(String(dshFixture.readSetupBinding('initErrorMessage'))).toContain('401');
    expect(
      dshFixture.host.querySelector<HTMLInputElement>('input[name="dshBridgeUrl"]')?.value,
    ).toBe('ws://127.0.0.1:23004/dsh/ws');
    expect(
      dshFixture.host.querySelector<HTMLInputElement>('input[name="dshBridgeToken"]')?.value,
    ).toBe('stale-bridge-token');
  });
});
