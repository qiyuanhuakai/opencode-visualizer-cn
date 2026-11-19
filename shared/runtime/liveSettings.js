export const LIVE_SETTINGS_PREFIX = 'vis.live-settings.v1.';
export const LIVE_SETTING_KEYS = Object.freeze([
  "settings.enterToSend.v1",
  "settings.suppressAutoWindows.v1",
  "settings.showMinimizeButtons.v1",
  "settings.dockAlwaysOpen.v1",
  "settings.terminalFontFamily.v1",
  "settings.appMonospaceFontFamily.v1",
  "settings.terminalFontSizePx.v1",
  "settings.appFontSizePx.v1",
  "settings.messageFontSizePx.v1",
  "settings.sidebarFontSizePx.v1",
  "settings.uiFontSizePx.v1",
  "settings.showOpenInEditorButton.v1",
  "settings.openInEditorMaxSizeMb.v1",
  "settings.floatingPreviewWordWrap.v1",
  "settings.showCodexButton.v1",
  "settings.showForgePanelButton.v1",
  "settings.showForgeButton.v1",
  "settings.editInVis.v1",
  "settings.editorFontSizePx.v1",
  "settings.editorTabSize.v1",
  "settings.editorShortcuts.v1",
  "settings.textTransformersEnabled.v1",
  "settings.textTransformers.v1",
  "settings.localApplicationPath.v1",
  "settings.regionTheme.v1",
  "settings.themeTokens.v2",
  "settings.themeRegistry.v1",
  "auth.backendKind.v1",
  "auth.credentials.v1",
  "auth.serverUrl.v1",
  "auth.codexBridgeUrl.v1",
  "auth.acpBridgeUrl.v1",
  "auth.kimiWebBridgeUrl.v1",
  "auth.dshBridgeUrl.v1",
  "auth.codexBridgeToken.v1",
  "auth.acpBridgeToken.v1",
  "auth.kimiWebBridgeToken.v1",
  "auth.dshBridgeToken.v1",
  "auth.dshAutoConnect.v1",
  "auth.acpAgentId.v1",
  "credentials.v1",
  "vis.runtime.bridgeUrl",
  "state.sidePanelCollapsed.v1",
  "state.sidePanelTab.v1"
]);
const keys = new Set(LIVE_SETTING_KEYS);
export const APPROVED_APPLICATION_KEY = 'settings.localApplicationPath.v1';
export function isLiveSetting(key) { return typeof key === 'string' && keys.has(key); }
export function liveSettingKey(key) {
  if (!isLiveSetting(key)) throw new TypeError('Unknown live setting');
  return LIVE_SETTINGS_PREFIX + key;
}
export function parseLiveSettingKey(key) {
  if (typeof key !== 'string' || !key.startsWith(LIVE_SETTINGS_PREFIX)) return null;
  const logical = key.slice(LIVE_SETTINGS_PREFIX.length);
  return isLiveSetting(logical) ? logical : null;
}
export function encodeLiveSetting(value) {
  if (value !== null && typeof value !== 'string') throw new TypeError('Invalid live setting value');
  return JSON.stringify({ version: 1, value });
}
export function decodeLiveSetting(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object' ||
        parsed.version !== 1 || !Object.hasOwn(parsed, 'value') ||
        Object.keys(parsed).length !== 2 || (parsed.value !== null && typeof parsed.value !== 'string')) return { kind: 'error' };
    return parsed.value === null ? { kind: 'missing' } : { kind: 'value', value: parsed.value };
  } catch { return { kind: 'error' }; }
}
export function normalizeSettingsChange(event, read) {
  const live = parseLiveSettingKey(event.key);
  if (live && event.newValue !== null && decodeLiveSetting(event.newValue).kind === 'error') return null;
  const legacy = typeof event.key === 'string' && event.key.startsWith('opencode.') ? event.key.slice(9) : null;
  const logical = live ?? legacy;
  if (!isLiveSetting(logical)) return event.key?.startsWith(LIVE_SETTINGS_PREFIX) ? null : event;
  const result = read(logical);
  if (result.kind === 'error') return null;
  return { key: 'opencode.' + logical, newValue: result.kind === 'value' ? result.value : null };
}
