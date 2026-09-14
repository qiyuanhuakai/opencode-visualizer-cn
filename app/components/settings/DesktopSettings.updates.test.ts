import { describe, expect, it, vi } from 'vitest';
// allow: SIZE_OK — updater transitions and pending Task 24 row assertions stay in one suite.
import {
  registerDesktopSettingsLifecycle,
  en,
  makeState,
  createDesktopApi,
  flushAsync,
  mountDesktopSettings,
  updateCards,
  cardFor,
  cardButton,
} from './DesktopSettings.shared';

registerDesktopSettingsLifecycle();

describe('DesktopSettings updates', () => {
  it('shares one row between the version text and the check actions in each update card', async () => {
    // Given: mounted settings with the desktop runtime.
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: in both cards the versions block and the actions block share a single summary row.
    for (const component of ['app', 'bridge'] as const) {
      const card = cardFor(host, component);
      const versions = card.querySelector('.desktop-update-versions');
      const actions = card.querySelector('.desktop-update-actions');
      expect(versions, `${component} card must render the versions block`).not.toBeNull();
      expect(actions, `${component} card must render its check action`).not.toBeNull();
      const summary = card.querySelector(':scope > .desktop-update-summary');
      expect(
        summary,
        `${component} card must place versions and the check action inside a shared summary row`,
      ).not.toBeNull();
      expect(versions!.parentElement).toBe(summary);
      expect(actions!.parentElement).toBe(summary);
      expect(
        versions!.compareDocumentPosition(actions!) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${component} card must render the versions before the check action`,
      ).not.toBe(0);

      // And: the summary row holds only the check button, never the phase actions.
      const summaryButtons = Array.from(actions!.querySelectorAll('button')).map((button) =>
        button.textContent?.trim(),
      );
      expect(summaryButtons).toEqual([en.updates.actions.check]);
      expect(card.querySelector('.desktop-update-extra-actions')).toBeNull();
    }
  });

  it('places download and install actions on a separate row below the summary', async () => {
    // Given: mounted settings with an available app update and a downloaded bridge update.
    const desktop = createDesktopApi(
      makeState({
        app: { phase: 'available', availableVersion: '1.5.0', assetName: 'Vis-1.5.0.AppImage' },
        bridge: { phase: 'downloaded', availableVersion: '0.9.2', progress: 100 },
      }),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: the app card keeps Check in the summary and Download on the extra row below.
    const appCard = cardFor(host, 'app');
    const appSummary = appCard.querySelector(':scope > .desktop-update-summary')!;
    const appExtra = appCard.querySelector(':scope > .desktop-update-extra-actions');
    expect(appExtra, 'app card must render the extra actions row below the summary').not.toBeNull();
    expect(
      appSummary.compareDocumentPosition(appExtra!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'extra actions must come after the summary row',
    ).not.toBe(0);
    expect(
      Array.from(appSummary.querySelectorAll('button')).map((button) => button.textContent?.trim()),
    ).toEqual([en.updates.actions.check]);
    expect(
      Array.from(appExtra!.querySelectorAll('button')).map((button) => button.textContent?.trim()),
    ).toEqual([en.updates.actions.download]);

    // And: the bridge card keeps Check in the summary and the manual install action below.
    const bridgeCard = cardFor(host, 'bridge');
    const bridgeExtra = bridgeCard.querySelector(':scope > .desktop-update-extra-actions');
    expect(bridgeExtra).not.toBeNull();
    expect(
      Array.from(bridgeCard.querySelectorAll(':scope > .desktop-update-summary button')).map(
        (button) => button.textContent?.trim(),
      ),
    ).toEqual([en.updates.actions.check]);
    expect(
      Array.from(bridgeExtra!.querySelectorAll('button')).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual([en.updates.actions.openInstaller]);
  });

  it('places the retry action on the extra row while the error phase keeps check in the summary', async () => {
    // Given: an app update in the error phase.
    const desktop = createDesktopApi(
      makeState({ app: { phase: 'error', error: 'network unreachable' } }),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: the summary keeps only the check action and retry lives on the extra row.
    const appCard = cardFor(host, 'app');
    expect(
      Array.from(appCard.querySelectorAll(':scope > .desktop-update-summary button')).map(
        (button) => button.textContent?.trim(),
      ),
    ).toEqual([en.updates.actions.check]);
    const extra = appCard.querySelector(':scope > .desktop-update-extra-actions');
    expect(extra).not.toBeNull();
    expect(
      Array.from(extra!.querySelectorAll('button')).map((button) => button.textContent?.trim()),
    ).toEqual([en.updates.actions.retry]);
  });

  it('keeps the versions row intact without actions for an unsupported component', async () => {
    // Given: a bridge component unsupported on this platform.
    const desktop = createDesktopApi(
      makeState({ bridge: { phase: 'unsupported', installKind: 'unsupported' } }),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: the summary row still holds the versions while the notice stays below it.
    const bridgeCard = cardFor(host, 'bridge');
    const summary = bridgeCard.querySelector(':scope > .desktop-update-summary');
    expect(summary).not.toBeNull();
    expect(summary!.querySelector('.desktop-update-versions')).not.toBeNull();
    expect(summary!.querySelector('button')).toBeNull();
    const notice = bridgeCard.querySelector(':scope > .desktop-notice');
    expect(
      notice,
      'unsupported notice must remain on its own row below the summary',
    ).not.toBeNull();
  });

  it('checks for updates and surfaces the available version with a download action', async () => {
    // Given: mounted settings whose check resolves to an available app update.
    const desktop = createDesktopApi(makeState());
    desktop.api.check = vi.fn(() =>
      Promise.resolve(
        makeState({
          app: { phase: 'available', availableVersion: '1.5.0', assetName: 'Vis-1.5.0.AppImage' },
        }),
      ),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // When: the app card check button is clicked.
    const appCard = cardFor(host, 'app');
    const checkButton = cardButton(appCard, en.updates.actions.check);
    expect(checkButton).toBeDefined();
    checkButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    // Then: the real API seam is invoked and the card reflects the returned phase.
    expect(desktop.api.check).toHaveBeenCalledWith('app');
    const updatedCard = cardFor(host, 'app');
    expect(updatedCard.textContent).toContain(en.updates.status.available);
    expect(updatedCard.textContent).toContain('Available: 1.5.0');
    expect(cardButton(updatedCard, en.updates.actions.download)).toBeDefined();
  });

  it('downloads and installs an automatic app update with restart labeling', async () => {
    // Given: an app update ready to download.
    const desktop = createDesktopApi(
      makeState({ app: { phase: 'available', availableVersion: '1.5.0' } }),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // When: download is requested.
    const downloadButton = cardButton(cardFor(host, 'app'), en.updates.actions.download);
    expect(downloadButton).toBeDefined();
    downloadButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(desktop.api.download).toHaveBeenCalledWith('app');

    // And: the runtime reports the download finished.
    desktop.emit(
      makeState({ app: { phase: 'downloaded', availableVersion: '1.5.0', progress: 100 } }),
    );
    await flushAsync();

    // Then: the automatic install action is labeled as install-and-restart.
    const installButton = cardButton(cardFor(host, 'app'), en.updates.actions.installRestart);
    expect(installButton).toBeDefined();
    installButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(desktop.api.install).toHaveBeenCalledWith('app');
  });

  it('uses manual-install labeling for the bridge and keeps installer-opened truthful', async () => {
    // Given: a downloaded bridge update (manual install kind).
    const desktop = createDesktopApi(
      makeState({ bridge: { phase: 'downloaded', availableVersion: '0.9.0', progress: 100 } }),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: the bridge card offers to open the installer instead of claiming a restart.
    const bridgeCard = cardFor(host, 'bridge');
    const openInstaller = cardButton(bridgeCard, en.updates.actions.openInstaller);
    expect(openInstaller).toBeDefined();
    expect(cardButton(bridgeCard, en.updates.actions.installRestart)).toBeUndefined();
    expect(bridgeCard.textContent).toContain(en.updates.bridgeInterruptNotice);

    // When: the installer is opened.
    openInstaller!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(desktop.api.install).toHaveBeenCalledWith('bridge');
    desktop.emit(
      makeState({
        bridge: { phase: 'installer-opened', availableVersion: '0.9.0', progress: 100 },
      }),
    );
    await flushAsync();

    // Then: the status says the installer opened, explicitly NOT that the update was installed.
    const updatedCard = cardFor(host, 'bridge');
    expect(updatedCard.textContent).toContain(en.updates.status.installerOpened);
    expect(updatedCard.textContent).toContain(en.updates.manualInstallerOpenedNotice);
    expect(updatedCard.textContent).toContain(en.updates.bridgeInterruptNotice);
    const remainingButtons = Array.from(updatedCard.querySelectorAll('button'));
    expect(remainingButtons.map((button) => button.textContent?.trim())).toEqual([
      en.updates.actions.check,
    ]);
  });

  it('renders download progress from state events and disables actions while busy', async () => {
    // Given: mounted settings that receive a downloading progress event.
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // When: the runtime pushes a 45% download progress state.
    desktop.emit(makeState({ app: { phase: 'downloading', progress: 45 } }));
    await flushAsync();

    // Then: a progressbar reflects the percent and the card actions are disabled.
    const appCard = cardFor(host, 'app');
    const progressbar = appCard.querySelector('[role="progressbar"]');
    expect(progressbar).not.toBeNull();
    expect(progressbar!.getAttribute('aria-valuenow')).toBe('45');
    expect(progressbar!.textContent).toContain('45%');
    const fill = appCard.querySelector('.desktop-progress-fill') as HTMLElement;
    expect(fill.style.width).toBe('45%');
    const buttons = Array.from(appCard.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.disabled).toBe(true);
  });

  it('shows the runtime error and retries through the check action', async () => {
    // Given: a mounted section whose app update falls into the error phase.
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();
    desktop.emit(makeState({ app: { phase: 'error', error: 'network unreachable' } }));
    await flushAsync();

    // Then: the raw error text and a retry action are rendered.
    const appCard = cardFor(host, 'app');
    expect(appCard.textContent).toContain('network unreachable');
    const retryButton = cardButton(appCard, en.updates.actions.retry);
    expect(retryButton).toBeDefined();

    // When: retry is clicked.
    retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Then: a fresh check crosses the API seam.
    expect(desktop.api.check).toHaveBeenCalledWith('app');
  });

  it('shows a load error with retry when the initial state fetch fails', async () => {
    // Given: a desktop runtime whose first getState rejects.
    const desktop = createDesktopApi(makeState());
    desktop.api.getState = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockImplementation(() => Promise.resolve(makeState()));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });

    // When: the section mounts.
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: the load error surface replaces the content and offers retry.
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(en.loadError);
    expect(host.querySelector('.desktop-update-card')).toBeNull();

    // When: retry is clicked and the runtime recovers.
    const retryButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === en.retry,
    ) as HTMLButtonElement;
    retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    // Then: the state is refetched and the cards render.
    expect(desktop.api.getState).toHaveBeenCalledTimes(2);
    expect(updateCards(host)).toHaveLength(2);
  });

  it('renders unsupported components without actions and with a truthful notice', async () => {
    // Given: a bridge component unsupported on this platform.
    const desktop = createDesktopApi(
      makeState({
        bridge: {
          phase: 'unsupported',
          installKind: 'unsupported',
          error: 'Bridge updates are unavailable on this platform or architecture',
        },
      }),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: the bridge card shows the unsupported badge/notice and no action buttons.
    const bridgeCard = cardFor(host, 'bridge');
    expect(bridgeCard.textContent).toContain(en.updates.status.unsupported);
    expect(bridgeCard.textContent).toContain(en.updates.unsupportedNotice);
    expect(bridgeCard.querySelector('button')).toBeNull();

    // And: the supported app card keeps its actions.
    expect(cardFor(host, 'app').querySelector('button')).not.toBeNull();
  });
});
