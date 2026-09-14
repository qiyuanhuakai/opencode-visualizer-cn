import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountHistoryApp, mountPausedInitializationApp } from './test/appHarness';
import { StorageKeys } from './utils/storageKeys';

const mountedApps: Array<{ readonly unmount: () => void }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ unmount }) => unmount());
});

async function selectSession(host: HTMLElement, title: string) {
  const picker = host.querySelector('.top-panel .ui-dropdown-button');
  expect(picker).toBeInstanceOf(HTMLButtonElement);
  picker?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await vi.waitFor(() => {
    const session = Array.from(host.querySelectorAll('.ui-dropdown-item')).find((item) =>
      item.textContent?.includes(title),
    );
    if (!session) throw new Error(`${title} did not appear in the picker`);
    session.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await vi.waitFor(() => expect(picker?.textContent).toContain(title));
}

function historyFor(sessionId: string) {
  return [
    {
      info: {
        id: `message-${sessionId}`,
        sessionID: sessionId,
        role: 'user',
        agent: 'build',
        model: { providerID: 'provider-a', modelID: 'model-a' },
        time: { created: 101 },
      },
      parts: [
        {
          id: `part-${sessionId}`,
          messageID: `message-${sessionId}`,
          sessionID: sessionId,
          type: 'text',
          text: `Loaded ${sessionId}`,
        },
      ],
    },
  ];
}

function changeCredential(
  fixture: Awaited<ReturnType<typeof mountHistoryApp>>,
  kind: 'opencode' | 'codex' | 'acp',
) {
  const key =
    kind === 'opencode'
      ? StorageKeys.auth.credentials
      : kind === 'codex'
        ? StorageKeys.auth.codexBridgeToken
        : StorageKeys.auth.acpBridgeToken;
  const newValue =
    kind === 'opencode'
      ? JSON.stringify({
          url: window.localStorage.getItem('opencode.auth.serverUrl.v1'),
          username: 'replacement-user',
          password: 'replacement-password',
        })
      : `${kind}-replacement`;
  fixture.dispatchStorageChange(key, newValue);
}

async function selectSessionAndWaitForHistory(
  fixture: Awaited<ReturnType<typeof mountHistoryApp>>,
  title: string,
) {
  const sessionId = title === 'Session A' ? 'session-a' : 'session-b';
  await selectSession(fixture.host, title);
  await vi.waitFor(() =>
    expect(fixture.listSessionMessages).toHaveBeenCalledWith(sessionId, {
      directory: '/repo',
    }),
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

describe('App backend authentication lifecycle', () => {
  it.each([
    ['OpenCode authorization', 'opencode'],
    ['Codex bridge token', 'codex'],
    ['ACP bridge token', 'acp'],
  ] as const)(
    'Given a cached session in the real App, When the %s changes, Then its old authentication namespace is invalidated',
    async (_credential, kind) => {
      const fixture = await mountHistoryApp([]);
      mountedApps.push(fixture);
      await vi.waitFor(() => expect(fixture.listSessionMessages).toHaveBeenCalled());
      fixture.listSessionMessages.mockImplementation(async (sessionId: string) =>
        historyFor(sessionId),
      );
      const picker = fixture.host.querySelector('.top-panel .ui-dropdown-button');
      const away = picker?.textContent?.includes('Session A') ? 'Session A' : 'Session B';
      const target = away === 'Session A' ? 'Session B' : 'Session A';
      await selectSessionAndWaitForHistory(fixture, target);
      await selectSessionAndWaitForHistory(fixture, away);
      fixture.listSessionMessages.mockClear();

      changeCredential(fixture, kind);
      expect(fixture.listSessionMessages).not.toHaveBeenCalled();
      await selectSessionAndWaitForHistory(fixture, target);

      const sessionId = target === 'Session A' ? 'session-a' : 'session-b';
      await vi.waitFor(() =>
        expect(fixture.listSessionMessages).toHaveBeenCalledWith(sessionId, {
          directory: '/repo',
        }),
      );
    },
  );

  it.each([401, 403])(
    'Given paused App initialization, When HTTP %s arrives, Then credentials clear and late startup cannot restore Ready',
    async (statusCode) => {
      const fixture = await mountPausedInitializationApp();
      mountedApps.push(fixture);

      fixture.emitConnectionError({ message: 'Authentication rejected', statusCode });

      expect(window.localStorage.getItem('opencode.auth.credentials.v1')).toBeNull();
      await vi.waitFor(() =>
        expect(fixture.host.querySelector('.app-error-message')?.textContent).toContain(
          `Authentication rejected (HTTP ${statusCode})`,
        ),
      );
      await fixture.releaseInitialization();
      expect(fixture.getPathInfo).not.toHaveBeenCalled();
      expect(fixture.host.querySelector('.top-panel')).toBeNull();
      expect(fixture.host.querySelector('.app-login-form')).toBeInstanceOf(HTMLElement);
    },
  );
});
