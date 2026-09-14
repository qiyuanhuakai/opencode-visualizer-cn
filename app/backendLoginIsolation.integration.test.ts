import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { mountLoginApp } from './test/appHarness';

const mountedApps: Array<{ readonly unmount: () => void }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ unmount }) => unmount());
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
});
