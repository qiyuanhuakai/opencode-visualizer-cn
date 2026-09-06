import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { getLocale } from '../i18n';
import type { DesktopApi, DesktopComponent, DesktopState } from '../types/desktop';

type DesktopUpdateAction = 'check' | 'download' | 'install';

type DesktopTogglePreferenceKey =
  | 'minimizeToTray'
  | 'closeToTray'
  | 'autoCheckUpdates'
  | 'autoDownloadUpdates'
  | 'idleNotifications'
  | 'notificationSound';

const BUSY_PHASES = new Set(['checking', 'downloading', 'installing']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useDesktopSettings() {
  const api: DesktopApi | undefined =
    typeof window === 'undefined' ? undefined : window.electronAPI?.desktop;
  const available = api !== undefined;

  const state = shallowRef<DesktopState | null>(null);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const savingPreferences = ref(false);
  const preferenceError = ref<string | null>(null);
  const pendingActions = shallowRef<Partial<Record<DesktopComponent, boolean>>>({});
  const actionErrors = shallowRef<Partial<Record<DesktopComponent, string | null>>>({});

  let loadGeneration = 0;
  let disposed = false;
  // Revision of pushed onState events; stale awaited responses never overwrite newer events.
  let eventRevision = 0;

  const preferences = computed(() => state.value?.preferences ?? null);
  const updates = computed(() => state.value?.updates ?? null);

  function isComponentBusy(component: DesktopComponent): boolean {
    if (pendingActions.value[component]) return true;
    const phase = updates.value?.[component]?.phase;
    return phase !== undefined && BUSY_PHASES.has(phase);
  }

  function actionError(component: DesktopComponent): string | null {
    return actionErrors.value[component] ?? null;
  }

  function syncLocale(snapshot: DesktopState): void {
    if (!api || disposed) return;
    const startRevision = eventRevision;
    const current = getLocale();
    if (snapshot.preferences.locale === current) return;
    void api
      .configure({ locale: current })
      .then((next) => {
        if (!disposed && eventRevision === startRevision) state.value = next;
      })
      .catch((error: unknown) => {
        console.warn('[desktop-settings] failed to sync locale to the desktop runtime:', error);
      });
  }

  async function refresh(): Promise<void> {
    if (!api || disposed) return;
    const generation = ++loadGeneration;
    const startRevision = eventRevision;
    loading.value = true;
    loadError.value = null;
    try {
      const next = await api.getState();
      if (generation !== loadGeneration) return;
      if (eventRevision === startRevision) state.value = next;
      if (state.value) syncLocale(state.value);
    } catch (error) {
      if (generation !== loadGeneration) return;
      loadError.value = errorMessage(error);
    } finally {
      if (generation === loadGeneration) loading.value = false;
    }
  }

  async function setPreference(key: DesktopTogglePreferenceKey, value: boolean): Promise<void> {
    if (!api || disposed || savingPreferences.value) return;
    const startRevision = eventRevision;
    savingPreferences.value = true;
    preferenceError.value = null;
    try {
      const next = await api.configure({ [key]: value });
      if (!disposed && eventRevision === startRevision) state.value = next;
    } catch (error) {
      preferenceError.value = errorMessage(error);
    } finally {
      savingPreferences.value = false;
    }
  }

  async function runUpdateAction(
    component: DesktopComponent,
    action: DesktopUpdateAction,
  ): Promise<void> {
    if (!api || disposed || pendingActions.value[component]) return;
    const startRevision = eventRevision;
    pendingActions.value = { ...pendingActions.value, [component]: true };
    actionErrors.value = { ...actionErrors.value, [component]: null };
    try {
      const next = await api[action](component);
      if (!disposed && eventRevision === startRevision) state.value = next;
    } catch (error) {
      actionErrors.value = { ...actionErrors.value, [component]: errorMessage(error) };
    } finally {
      pendingActions.value = { ...pendingActions.value, [component]: false };
    }
  }

  function checkComponent(component: DesktopComponent): Promise<void> {
    return runUpdateAction(component, 'check');
  }

  function downloadComponent(component: DesktopComponent): Promise<void> {
    return runUpdateAction(component, 'download');
  }

  function installComponent(component: DesktopComponent): Promise<void> {
    return runUpdateAction(component, 'install');
  }

  if (available) {
    const unsubscribe = api.onState((next) => {
      eventRevision += 1;
      state.value = next;
    });
    if (getCurrentScope()) onScopeDispose(() => {
      disposed = true;
      loadGeneration += 1;
      unsubscribe();
    });
    void refresh();
  }

  return {
    available,
    state,
    loading,
    loadError,
    preferences,
    updates,
    savingPreferences,
    preferenceError,
    isComponentBusy,
    actionError,
    refresh,
    setPreference,
    checkComponent,
    downloadComponent,
    installComponent,
  };
}
