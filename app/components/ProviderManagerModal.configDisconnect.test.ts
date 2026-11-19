// RED harness for PR #182 finding 2: the Disconnect control for a
// config-backed provider must be judged by the SAME execution branch
// `disconnectProvider` uses. The real Codex adapter exposes
// `updateGlobalConfig` but NOT `deleteProviderAuth`, and it emits
// `source=config` custom providers — so gating every provider on
// `deleteProviderAuth` wrongly disconnects nothing on Codex.
//
// The reproduction below mounts the real modal with a backend double shaped
// like the real Codex adapter (no `deleteProviderAuth`), exactly as the
// independent reviewer did in round 081ff620a.
import { describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  flushUi,
  mountProviderManager,
  setProviderBackend,
} from './providerManagerModal.test-helpers';

/** The real Codex adapter method surface: config updates yes, provider-auth deletion no. */
function realCodexBackend() {
  return {
    kind: 'codex',
    updateGlobalConfig: vi.fn(async (payload: Record<string, unknown>) => payload),
    listProviderAuthMethods: vi.fn(async () => ({})),
  };
}

describe('ProviderManagerModal config-backed disconnect (PR #182 finding 2)', () => {
  it('keeps a connected Codex config-backed provider disconnectable through the config branch', async () => {
    const backend = realCodexBackend();
    setProviderBackend(backend);
    const showConfirm = vi.fn(async () => true);
    const { host, events } = await mountProviderManager({
      backendKind: 'codex',
      providers: [{ id: 'proxyhub', name: 'Proxy Hub', source: 'config', models: {} }],
      connectedProviderIds: ['proxyhub'],
      providerConfig: {
        enabled_providers: ['proxyhub'],
        model_providers: { proxyhub: { name: 'Proxy Hub' } },
      },
      showConfirm,
    });

    const disconnect = buttonByText(host, 'Disconnect');
    expect(disconnect.disabled).toBe(false);
    disconnect.click();
    await flushUi();

    expect(showConfirm).toHaveBeenCalledOnce();
    expect(backend.updateGlobalConfig).toHaveBeenCalledExactlyOnceWith({
      disabled_providers: ['proxyhub'],
    });
    expect(events.configUpdated).toHaveBeenCalledOnce();
    expect(events.providersChanged).toHaveBeenCalledOnce();
  });

  it('keeps a credential-backed provider gated on the auth-deletion branch it actually uses', async () => {
    const backend = realCodexBackend();
    setProviderBackend(backend);
    const { host } = await mountProviderManager({
      backendKind: 'codex',
      providers: [{ id: 'api-only', name: 'API Only', source: 'api', models: {} }],
      connectedProviderIds: ['api-only'],
      providerConfig: { enabled_providers: ['api-only'] },
      showConfirm: vi.fn(async () => true),
    });

    // A credential-backed provider still needs deleteProviderAuth: the real
    // Codex adapter has none, so the control stays unavailable rather than
    // silently routing to a branch that would never delete the credential.
    expect(buttonByText(host, 'Disconnect').disabled).toBe(true);
  });

  it('keeps an environment-sourced provider disconnected nowhere', async () => {
    const backend = realCodexBackend();
    setProviderBackend(backend);
    const { host } = await mountProviderManager({
      backendKind: 'codex',
      providers: [{ id: 'env-only', name: 'Env Only', source: 'env', models: {} }],
      connectedProviderIds: ['env-only'],
    });
    expect(buttonByText(host, 'Disconnect').disabled).toBe(true);
  });
});
