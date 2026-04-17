<template>
  <dialog
    ref="dialogRef"
    class="modal-backdrop"
    @close="$emit('close')"
    @cancel.prevent
    @click.self="dialogRef?.close()"
  >
    <div class="modal">
      <header class="modal-header">
        <div class="modal-header-main">
          <button
            v-if="activePage !== 'root'"
            type="button"
            class="modal-back-button"
            :aria-label="$t('settings.backToRoot')"
            @click="activePage = 'root'"
          >
            <Icon icon="lucide:arrow-left" :width="14" :height="14" />
          </button>
          <div class="modal-title">{{ activePage === 'root' ? $t('settings.title') : (activePage === 'fonts' ? $t('settings.fontsPageTitle') : $t('settings.themePageTitle')) }}</div>
        </div>
        <button
          type="button"
          class="modal-close-button"
          :aria-label="$t('settings.close')"
          @click="dialogRef?.close()"
        >
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </header>
      <div class="modal-body">
        <template v-if="activePage === 'root'">
          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.language.label') }}</div>
              <div class="setting-description">{{ $t('settings.language.description') }}</div>
            </div>
            <select v-model="locale" class="language-select">
              <option value="en">{{ $t('settings.language.en') }}</option>
              <option value="zh-CN">{{ $t('settings.language.zhCN') }}</option>
            </select>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.enterToSend.label') }}</div>
              <div class="setting-description">{{ $t('settings.enterToSend.description') }}</div>
            </div>
            <label class="toggle-switch">
              <input v-model="enterToSend" type="checkbox" class="toggle-input" />
              <span class="toggle-track" />
            </label>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.showMinimizeButtons.label') }}</div>
              <div class="setting-description">{{ $t('settings.showMinimizeButtons.description') }}</div>
            </div>
            <label class="toggle-switch">
              <input v-model="showMinimizeButtons" type="checkbox" class="toggle-input" />
              <span class="toggle-track" />
            </label>
          </div>

          <div class="setting-row" :class="{ 'setting-row-disabled': !showMinimizeButtons }">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.dockAlwaysOpen.label') }}</div>
              <div class="setting-description">{{ $t('settings.dockAlwaysOpen.description') }}</div>
            </div>
            <label
              class="toggle-switch"
              :title="showMinimizeButtons ? $t('settings.dockAlwaysOpen.label') : $t('settings.showMinimizeButtons.label')"
            >
              <input
                v-model="dockAlwaysOpen"
                type="checkbox"
                class="toggle-input"
                :disabled="!showMinimizeButtons"
              />
              <span class="toggle-track" />
            </label>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.showOpenInEditorButton.label') }}</div>
              <div class="setting-description">{{ $t('settings.showOpenInEditorButton.description') }}</div>
            </div>
            <label class="toggle-switch">
              <input v-model="showOpenInEditorButton" type="checkbox" class="toggle-input" />
              <span class="toggle-track" />
            </label>
          </div>

          <div class="setting-row setting-row-stack">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.openInEditorMaxSizeMb.label') }}</div>
              <div class="setting-description">{{ $t('settings.openInEditorMaxSizeMb.description') }}</div>
            </div>
            <div class="number-setting-group">
              <input
                v-model.number="openInEditorMaxSizeMb"
                type="number"
                class="number-input"
                :min="minOpenInEditorMaxSizeMb"
                :max="maxOpenInEditorMaxSizeMb"
                step="1"
              />
            </div>
          </div>

          <div class="setting-row setting-row-stack">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.pinnedSessionsLimit.label') }}</div>
              <div class="setting-description">{{ $t('settings.pinnedSessionsLimit.description', { limit: maxPinnedSessionsLimit }) }}</div>
            </div>
            <div class="number-setting-group">
              <input
                v-model.number="pinnedSessionsLimit"
                type="number"
                class="number-input"
                :min="minPinnedSessionsLimit"
                :max="maxPinnedSessionsLimit"
                step="1"
              />
            </div>
          </div>

          <button
            type="button"
            class="setting-row setting-link-row"
            :aria-label="$t('settings.fontSettings.label')"
            @click="activePage = 'fonts'"
          >
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.fontSettings.label') }}</div>
              <div class="setting-description">{{ $t('settings.fontSettings.description') }}</div>
            </div>
            <Icon icon="lucide:chevron-right" :width="16" :height="16" class="setting-link-icon" />
          </button>

          <button
            type="button"
            class="setting-row setting-link-row"
            :aria-label="$t('settings.theme.label')"
            @click="activePage = 'theme'"
          >
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.theme.label') }}</div>
              <div class="setting-description">{{ $t('settings.theme.description') }}</div>
            </div>
            <Icon icon="lucide:chevron-right" :width="16" :height="16" class="setting-link-icon" />
          </button>
        </template>

        <template v-else-if="activePage === 'theme'">
          <div class="setting-page-description">{{ $t('settings.theme.description') }}</div>

          <div class="setting-row setting-row-stack theme-settings-section">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.theme.presetLabel') }}</div>
              <div class="setting-description">{{ $t('settings.theme.presetDescription') }}</div>
            </div>
            <div class="theme-preset-grid" role="list">
              <button
                v-for="preset in themePresetCards"
                :key="preset.id"
                type="button"
                class="theme-preset-card"
                :class="{ 'is-active': selectedPreset === preset.id }"
                :aria-pressed="selectedPreset === preset.id"
                @click="selectedPreset = preset.id"
              >
                <div class="theme-preset-card-header">
                  <div class="theme-preset-card-title">{{ preset.label }}</div>
                  <span class="theme-preset-card-badge">{{ preset.badge }}</span>
                </div>
                <div class="theme-preset-preview" aria-hidden="true">
                  <span
                    v-for="swatch in preset.swatches"
                    :key="`${preset.id}-${swatch}`"
                    class="theme-preset-swatch"
                    :style="{ background: swatch }"
                  />
                </div>
                <div class="theme-preset-card-description">{{ preset.description }}</div>
                <button
                  v-if="preset.removable"
                  type="button"
                  class="theme-preset-remove"
                  @click.stop="removeThemePreset(preset.id)"
                >
                  {{ $t('settings.theme.removeExternal') }}
                </button>
              </button>
            </div>
          </div>

          <div class="setting-row setting-row-stack theme-settings-section">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.theme.managementLabel') }}</div>
              <div class="setting-description">
                {{ $t('settings.theme.managementDescription') }}
              </div>
            </div>
            <div class="theme-management-area">
              <div class="theme-management-top">
                <div class="theme-current-profile">
                  <span class="theme-current-label">{{ $t('settings.theme.currentProfileLabel') }}</span>
                  <span class="theme-current-value">{{ activeThemeSummary }}</span>
                </div>
                <div class="theme-action-bar">
                  <label class="font-system-button theme-import-button" :class="{ 'is-disabled': isImportingTheme }">
                    <input
                      class="theme-import-input"
                      type="file"
                      accept="application/json"
                      :disabled="isImportingTheme"
                      @change="importThemeFile"
                    >
                    {{ isImportingTheme ? $t('settings.theme.importing') : $t('settings.theme.importAction') }}
                  </label>
                  <button type="button" class="font-system-button" @click="exportCurrentTheme">
                    {{ $t('settings.theme.exportCurrentAction') }}
                  </button>
                  <button type="button" class="font-system-button" @click="exportThemeTemplate">
                    {{ $t('settings.theme.exportTemplateAction') }}
                  </button>
                </div>
              </div>
              <div class="theme-action-meta">
                <span class="theme-import-hint">{{ $t('settings.theme.importHint') }}</span>
                <a class="theme-schema-link" :href="themeSchemaUrl" target="_blank" rel="noreferrer">
                  {{ $t('settings.theme.schemaLink') }}
                </a>
              </div>
              <div v-if="themeImportError" class="theme-import-error">{{ themeImportError }}</div>
            </div>
          </div>

        </template>

        <template v-else>
          <div class="setting-page-description">{{ $t('settings.fontSettings.description') }}</div>

          <div class="setting-row setting-row-font">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.terminalFontFamily.label') }}</div>
              <div class="setting-description">{{ $t('settings.terminalFontFamily.description') }}</div>
            </div>
            <div class="font-setting-controls">
              <div class="font-setting-section">
                <div :id="terminalPresetLabelId" class="font-setting-section-label">{{ $t('settings.fontPresetsLabel') }}</div>
                <div class="font-preset-row" role="group" :aria-labelledby="terminalPresetLabelId">
                  <button
                    v-for="preset in terminalFontPresets"
                    :key="preset.id"
                    type="button"
                    class="font-preset-chip"
                    :class="{ 'is-active': isFontPresetSelected(terminalFontFamily, preset.value) }"
                    :aria-pressed="isFontPresetSelected(terminalFontFamily, preset.value)"
                    @click="terminalFontFamily = preset.value"
                  >
                    {{ preset.label }}
                  </button>
                </div>
              </div>
              <div class="font-setting-section">
                <label :id="terminalInputLabelId" class="font-setting-section-label" :for="terminalTextareaId">
                  {{ $t('settings.customFontStackLabel') }}
                </label>
                <textarea
                  :id="terminalTextareaId"
                  v-model.trim="terminalFontFamily"
                  class="font-stack-input"
                  rows="3"
                  spellcheck="false"
                  autocapitalize="off"
                  autocomplete="off"
                  :placeholder="defaultTerminalFontFamily"
                  :aria-describedby="terminalPresetLabelId"
                />
                <div class="font-stack-status-list" role="status" aria-live="polite">
                  <div
                    v-for="entry in terminalFontStatusEntries"
                    :key="`terminal-${entry.family}`"
                    class="font-stack-status-item"
                    :class="`is-${entry.status}`"
                  >
                    <span class="font-stack-status-name">{{ entry.family }}</span>
                    <span class="font-stack-status-value">{{ getFontStatusLabel(entry.status) }}</span>
                  </div>
                </div>
              </div>
              <div class="font-setting-section">
                <button
                  type="button"
                  class="font-discovery-toggle"
                  :aria-expanded="isTerminalFontDiscoveryOpen"
                  @click="toggleFontDiscovery('terminal')"
                >
                  <span>{{ $t('settings.systemFonts.label') }}</span>
                  <Icon
                    :icon="isTerminalFontDiscoveryOpen ? 'lucide:chevron-up' : 'lucide:chevron-down'"
                    :width="14"
                    :height="14"
                  />
                </button>
                <div v-if="isTerminalFontDiscoveryOpen" class="font-discovery-panel">
                  <div class="font-system-actions">
                    <button
                      v-if="supportsLocalFontsApi"
                      type="button"
                      class="font-system-button"
                      :disabled="isLoadingLocalFonts"
                      @click="loadLocalFonts"
                    >
                      {{ isLoadingLocalFonts ? $t('settings.systemFonts.loading') : $t('settings.systemFonts.scan') }}
                    </button>
                    <div v-else class="font-system-hint">{{ $t('settings.systemFonts.unsupported') }}</div>
                    <div v-if="localFontsError" class="font-system-error">{{ localFontsError }}</div>
                  </div>
                  <div v-if="localFontFamilies.length > 0" class="font-system-list" role="list">
                    <button
                      v-for="font in localFontFamilies"
                      :key="`terminal-${font.family}`"
                      type="button"
                      class="font-system-item"
                      @click="terminalFontFamily = prependFamily(terminalFontFamily, font.family)"
                    >
                      <span class="font-system-family">{{ font.family }}</span>
                      <span class="font-system-meta">{{ font.styles.join(', ') || $t('settings.systemFonts.regular') }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="setting-row setting-row-font">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.appMonospaceFontFamily.label') }}</div>
              <div class="setting-description">{{ $t('settings.appMonospaceFontFamily.description') }}</div>
            </div>
            <div class="font-setting-controls">
              <div class="font-setting-section">
                <div :id="appPresetLabelId" class="font-setting-section-label">{{ $t('settings.fontPresetsLabel') }}</div>
                <div class="font-preset-row" role="group" :aria-labelledby="appPresetLabelId">
                  <button
                    v-for="preset in appMonospaceFontPresets"
                    :key="preset.id"
                    type="button"
                    class="font-preset-chip"
                    :class="{ 'is-active': isFontPresetSelected(appMonospaceFontFamily, preset.value) }"
                    :aria-pressed="isFontPresetSelected(appMonospaceFontFamily, preset.value)"
                    @click="appMonospaceFontFamily = preset.value"
                  >
                    {{ preset.label }}
                  </button>
                </div>
              </div>
              <div class="font-setting-section">
                <label :id="appInputLabelId" class="font-setting-section-label" :for="appTextareaId">
                  {{ $t('settings.customFontStackLabel') }}
                </label>
                <textarea
                  :id="appTextareaId"
                  v-model.trim="appMonospaceFontFamily"
                  class="font-stack-input"
                  rows="3"
                  spellcheck="false"
                  autocapitalize="off"
                  autocomplete="off"
                  :placeholder="defaultAppMonospaceFontFamily"
                  :aria-describedby="appPresetLabelId"
                />
                <div class="font-stack-status-list" role="status" aria-live="polite">
                  <div
                    v-for="entry in appFontStatusEntries"
                    :key="`app-${entry.family}`"
                    class="font-stack-status-item"
                    :class="`is-${entry.status}`"
                  >
                    <span class="font-stack-status-name">{{ entry.family }}</span>
                    <span class="font-stack-status-value">{{ getFontStatusLabel(entry.status) }}</span>
                  </div>
                </div>
              </div>
              <div class="font-setting-section">
                <button
                  type="button"
                  class="font-discovery-toggle"
                  :aria-expanded="isAppFontDiscoveryOpen"
                  @click="toggleFontDiscovery('app')"
                >
                  <span>{{ $t('settings.systemFonts.label') }}</span>
                  <Icon
                    :icon="isAppFontDiscoveryOpen ? 'lucide:chevron-up' : 'lucide:chevron-down'"
                    :width="14"
                    :height="14"
                  />
                </button>
                <div v-if="isAppFontDiscoveryOpen" class="font-discovery-panel">
                  <div class="font-system-actions">
                    <button
                      v-if="supportsLocalFontsApi"
                      type="button"
                      class="font-system-button"
                      :disabled="isLoadingLocalFonts"
                      @click="loadLocalFonts"
                    >
                      {{ isLoadingLocalFonts ? $t('settings.systemFonts.loading') : $t('settings.systemFonts.scan') }}
                    </button>
                    <div v-else class="font-system-hint">{{ $t('settings.systemFonts.unsupported') }}</div>
                    <div v-if="localFontsError" class="font-system-error">{{ localFontsError }}</div>
                  </div>
                  <div v-if="localFontFamilies.length > 0" class="font-system-list" role="list">
                    <button
                      v-for="font in localFontFamilies"
                      :key="`app-${font.family}`"
                      type="button"
                      class="font-system-item"
                      @click="appMonospaceFontFamily = prependFamily(appMonospaceFontFamily, font.family)"
                    >
                      <span class="font-system-family">{{ font.family }}</span>
                      <span class="font-system-meta">{{ font.styles.join(', ') || $t('settings.systemFonts.regular') }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch, watchEffect } from 'vue';
import { Icon } from '@iconify/vue';
import { useSettings } from '../composables/useSettings';
import { useI18n } from 'vue-i18n';
import { getLocale, setLocale } from '../i18n';
import type { Locale } from '../i18n/types';
import { downloadJsonFile } from '../utils/fileExport';
import {
  inspectFontStack,
  loadLocalFontFamilies,
  prependFontFamilyToStack,
  supportsLocalFontAccess,
  type FontAvailabilityStatus,
  type LocalFontFamily,
} from '../utils/fontDiscovery';
import {
  resolveThemeStoragePreset,
  regionThemeToStorage,
} from '../utils/themeTokens';
import {
  DEFAULT_REGION_THEME,
  resolveRegionThemePresetName,
} from '../utils/regionTheme';
import {
  THEME_SCHEMA_URL,
  createExternalThemeDefinition,
  createThemeTemplate,
  listThemeRegistryEntries,
  parseExternalThemeFileText,
  removeStoredExternalTheme,
  resolveThemeRegistryEntry,
  resolveThemeRegistryTheme,
  type ThemeRegistryEntry,
} from '../utils/themeRegistry';

type FontPreset = {
  id: string;
  label: string;
  value: string;
};

type SettingsPage = 'root' | 'fonts' | 'theme';
type ThemePresetCard = {
  id: string;
  label: string;
  badge: string;
  description: string;
  swatches: string[];
  source: 'builtin' | 'external';
  removable: boolean;
};

const props = defineProps<{
  open: boolean;
}>();

defineEmits<{
  (event: 'close'): void;
}>();

const { t } = useI18n();
const dialogRef = ref<HTMLDialogElement | null>(null);
const activePage = ref<SettingsPage>('root');
const terminalPresetLabelId = 'settings-terminal-font-presets';
const terminalInputLabelId = 'settings-terminal-font-input-label';
const terminalTextareaId = 'settings-terminal-font-input';
const appPresetLabelId = 'settings-app-font-presets';
const appInputLabelId = 'settings-app-font-input-label';
const appTextareaId = 'settings-app-font-input';
const supportsLocalFontsApi = supportsLocalFontAccess();
const isLoadingLocalFonts = ref(false);
const localFontsError = ref('');
const localFontFamilies = ref<LocalFontFamily[]>([]);
const isTerminalFontDiscoveryOpen = ref(false);
const isAppFontDiscoveryOpen = ref(false);
const themeImportError = ref('');
const isImportingTheme = ref(false);
const {
  enterToSend,
  showMinimizeButtons,
  dockAlwaysOpen,
  pinnedSessionsLimit,
  terminalFontFamily,
  appMonospaceFontFamily,
  themeStorage,
  externalThemes,
  minPinnedSessionsLimit,
  maxPinnedSessionsLimit,
  defaultTerminalFontFamily,
  defaultAppMonospaceFontFamily,
  showOpenInEditorButton,
  openInEditorMaxSizeMb,
  minOpenInEditorMaxSizeMb,
  maxOpenInEditorMaxSizeMb,
} = useSettings();
const activeThemeStorage = themeStorage;
const selectedPreset = ref<string>('default');
let isSyncingThemeEditorState = false;

const themeRegistryEntries = computed<ThemeRegistryEntry[]>(() => listThemeRegistryEntries(externalThemes.value));
const themeSchemaUrl = computed(() => new URL(THEME_SCHEMA_URL, window.location.href).toString());

function syncSelectedPresetFromActiveTheme() {
  const activePresetName = activeThemeStorage.value
    ? resolveThemeStoragePreset(activeThemeStorage.value)
    : resolveRegionThemePresetName(DEFAULT_REGION_THEME.name);

  if (!activeThemeStorage.value || !activePresetName || activePresetName === 'default') {
    selectedPreset.value = 'default';
    return;
  }

  selectedPreset.value = activePresetName;
}

function syncThemeEditorState() {
  isSyncingThemeEditorState = true;
  try {
    syncSelectedPresetFromActiveTheme();
  } finally {
    isSyncingThemeEditorState = false;
  }
}

function applyPreset(name: string) {
  const presetTheme = name === DEFAULT_REGION_THEME.name ? null : resolveThemeRegistryTheme(name, externalThemes.value);
  activeThemeStorage.value = presetTheme ? regionThemeToStorage(presetTheme) : null;
}

function resetTheme() {
  activeThemeStorage.value = null;
}

async function importThemeFile(event: Event) {
  const input = event.target as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!file) return;

  isImportingTheme.value = true;
  themeImportError.value = '';
  try {
    const text = await file.text();
    const importedTheme = parseExternalThemeFileText(text);
    const nextThemes = new Map(externalThemes.value.map((theme) => [theme.id, theme]));
    nextThemes.set(importedTheme.id, importedTheme);
    externalThemes.value = Array.from(nextThemes.values());
    selectedPreset.value = importedTheme.id;
  } catch (error) {
    themeImportError.value = error instanceof Error ? error.message : t('settings.theme.importError');
  } finally {
    isImportingTheme.value = false;
    if (input) {
      input.value = '';
    }
  }
}

function removeThemePreset(id: string) {
  const entry = resolveThemeRegistryEntry(id, externalThemes.value);
  if (!entry?.removable) return;
  externalThemes.value = removeStoredExternalTheme(externalThemes.value, id);
  if (selectedPreset.value === id || resolveThemeStoragePreset(activeThemeStorage.value) === id) {
    resetTheme();
    selectedPreset.value = 'default';
  }
}

function exportThemeTemplate() {
  downloadJsonFile(createThemeTemplate(), 'vis-theme-template.json');
}

function exportCurrentTheme() {
  const activePresetName = resolveThemeStoragePreset(activeThemeStorage.value);
  const activeEntry = resolveThemeRegistryEntry(activePresetName, externalThemes.value);
  const themeDefinition = activeEntry
    ? createExternalThemeDefinition(activeEntry.theme, {
        badge: activeEntry.badge,
        description: activeEntry.description,
        swatches: activeEntry.swatches,
      })
    : createThemeTemplate('current-theme', t('settings.theme.exportCurrentFallbackName'));

  downloadJsonFile(themeDefinition, `${themeDefinition.id}.theme.json`);
}

watch(selectedPreset, (val) => {
  if (isSyncingThemeEditorState) {
    return;
  }

  if (val === DEFAULT_REGION_THEME.name) {
    resetTheme();
  } else {
    applyPreset(val);
  }
});

watch(activePage, (page) => {
  if (page === 'theme') {
    syncThemeEditorState();
  }
});

onMounted(() => {
  if (activePage.value === 'theme') {
    syncThemeEditorState();
  }
});

const themePresetCards = computed<ThemePresetCard[]>(() =>
  themeRegistryEntries.value.map((entry) => ({
    id: entry.id,
    label: entry.labelKey ? t(entry.labelKey) : entry.theme.label,
    badge: entry.badgeKey ? t(entry.badgeKey) : (entry.badge ?? t('settings.theme.externalBadge')),
    description: entry.descriptionKey ? t(entry.descriptionKey) : (entry.description ?? t('settings.theme.externalDescription')),
    swatches: entry.swatches,
    source: entry.source,
    removable: entry.removable,
  })),
);

const activeThemeSummary = computed(() => {
  const presetName = resolveThemeStoragePreset(activeThemeStorage.value);
  if (!presetName || presetName === 'default') {
    return t('settings.theme.currentProfileDefault');
  }

  const entry = resolveThemeRegistryEntry(presetName, externalThemes.value);
  return t('settings.theme.currentProfilePreset', {
    name: entry?.theme.label ?? presetName,
  });
});

const debouncedTerminalFontFamily = ref(terminalFontFamily.value);
const debouncedAppMonospaceFontFamily = ref(appMonospaceFontFamily.value);

const terminalFontPresets = computed<FontPreset[]>(() => [
  {
    id: 'default',
    label: t('settings.fontPresets.default'),
    value: defaultTerminalFontFamily,
  },
  {
    id: 'firacode',
    label: t('settings.fontPresets.firaCodeNerd'),
    value: "'FiraCode Nerd Font Mono', 'FiraCode Nerd Font Mono Med', monospace",
  },
  {
    id: 'caskaydia',
    label: t('settings.fontPresets.caskaydiaNerd'),
    value: "'CaskaydiaCove Nerd Font Mono', 'CaskaydiaCove NFM', monospace",
  },
  {
    id: 'iosevka',
    label: t('settings.fontPresets.iosevkaTerm'),
    value: "'IosevkaTerm Nerd Font', 'Iosevka Term', 'Iosevka Fixed', monospace",
  },
  {
    id: 'jetbrains',
    label: t('settings.fontPresets.jetbrainsMono'),
    value: "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', monospace",
  },
]);

const appMonospaceFontPresets = computed<FontPreset[]>(() => [
  {
    id: 'default',
    label: t('settings.fontPresets.default'),
    value: defaultAppMonospaceFontFamily,
  },
  {
    id: 'sfmono',
    label: t('settings.fontPresets.sfMono'),
    value: "'SF Mono', 'SFMono-Regular', ui-monospace, 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', monospace",
  },
  {
    id: 'jetbrains',
    label: t('settings.fontPresets.jetbrainsMono'),
    value: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', monospace",
  },
  {
    id: 'firacode',
    label: t('settings.fontPresets.firaCode'),
    value: "'Fira Code', ui-monospace, 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', monospace",
  },
  {
    id: 'iosevka',
    label: t('settings.fontPresets.iosevkaTerm'),
    value: "'Iosevka Term', 'Iosevka Fixed', ui-monospace, 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', monospace",
  },
]);

function normalizeFontStack(value: string) {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');
}

function isFontPresetSelected(currentValue: string, presetValue: string) {
  return normalizeFontStack(currentValue) === normalizeFontStack(presetValue);
}

const terminalFontStatusEntries = computed(() => inspectFontStack(debouncedTerminalFontFamily.value).slice(0, 8));
const appFontStatusEntries = computed(() => inspectFontStack(debouncedAppMonospaceFontFamily.value).slice(0, 8));

function getFontStatusLabel(status: FontAvailabilityStatus) {
  if (status === 'available') return t('settings.fontStatus.available');
  if (status === 'generic') return t('settings.fontStatus.generic');
  return t('settings.fontStatus.missing');
}

function prependFamily(stack: string, family: string) {
  return prependFontFamilyToStack(stack, family);
}

function toggleFontDiscovery(target: 'terminal' | 'app') {
  if (target === 'terminal') {
    isTerminalFontDiscoveryOpen.value = !isTerminalFontDiscoveryOpen.value;
    return;
  }
  isAppFontDiscoveryOpen.value = !isAppFontDiscoveryOpen.value;
}

async function loadLocalFonts() {
  if (!supportsLocalFontsApi || isLoadingLocalFonts.value) return;
  isLoadingLocalFonts.value = true;
  localFontsError.value = '';
  try {
    localFontFamilies.value = await loadLocalFontFamilies();
  } catch {
    localFontsError.value = t('settings.systemFonts.error');
  } finally {
    isLoadingLocalFonts.value = false;
  }
}

watchEffect((onCleanup) => {
  const nextValue = terminalFontFamily.value;
  const timer = window.setTimeout(() => {
    debouncedTerminalFontFamily.value = nextValue;
  }, 140);
  onCleanup(() => window.clearTimeout(timer));
});

watchEffect((onCleanup) => {
  const nextValue = appMonospaceFontFamily.value;
  const timer = window.setTimeout(() => {
    debouncedAppMonospaceFontFamily.value = nextValue;
  }, 140);
  onCleanup(() => window.clearTimeout(timer));
});

const locale = ref<Locale>(getLocale());
watch(locale, (newLocale) => {
  setLocale(newLocale);
});

watch(
  () => props.open,
  (open) => {
    const el = dialogRef.value;
    if (!el) return;
    if (open) {
      activePage.value = 'root';
      isTerminalFontDiscoveryOpen.value = false;
      isAppFontDiscoveryOpen.value = false;
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  },
);
</script>

<style scoped>
.modal-backdrop {
  border: none;
  padding: 0;
  margin: 0;
  background: transparent;
  color: inherit;
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-backdrop:not([open]) {
  display: none;
}

.modal-backdrop::backdrop {
  background: var(--theme-surface-overlay, rgba(2, 6, 23, 0.65));
}

.modal {
  width: min(760px, 96vw);
  max-height: min(88vh, 920px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--theme-modal-bg, var(--theme-surface-panel-elevated, rgba(15, 23, 42, 0.98)));
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 12px;
  box-shadow: var(--theme-shadow-panel, 0 12px 32px rgba(2, 6, 23, 0.45));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  font-family: var(--app-monospace-font-family);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.modal-header-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
}

.modal-back-button,
.modal-close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 6px;
  background: var(--theme-modal-control-bg, transparent);
  color: var(--theme-modal-text, var(--theme-text-muted, #94a3b8));
  cursor: pointer;
}

.modal-back-button:hover,
.modal-close-button:hover {
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-hover, #1e293b));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  padding-right: 4px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #1e293b));
  border-radius: 8px;
  background: var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.45)));
}

.setting-row-stack {
  align-items: flex-start;
}

.setting-row.theme-settings-section {
  flex-direction: column;
  align-items: stretch;
  border: none;
  background: transparent;
  padding-left: 0;
  padding-right: 0;
}

.setting-row-font {
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}

.setting-row-disabled {
  opacity: 0.55;
}

.setting-link-row {
  width: 100%;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  text-align: left;
  cursor: pointer;
}

.setting-link-row:hover {
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-hover, rgba(15, 23, 42, 0.72)));
  border-color: var(--theme-modal-accent, var(--theme-border-strong, #475569));
}

.setting-link-icon {
  flex: 0 0 auto;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
}

.setting-page-description {
  margin: 2px 2px 0;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
  font-size: 11px;
}

.theme-preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  width: 100%;
}

.theme-preset-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 10px;
  background: var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.45)));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  text-align: left;
  cursor: pointer;
}

.theme-preset-card:hover {
  border-color: var(--theme-modal-accent, var(--theme-border-strong, #475569));
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-hover, rgba(15, 23, 42, 0.72)));
}

.theme-preset-card.is-active {
  border-color: var(--theme-modal-accent, var(--theme-border-accent, rgba(59, 130, 246, 0.45)));
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-active, rgba(59, 130, 246, 0.16)));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6)) 35%, transparent);
}

.theme-preset-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.theme-preset-card-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.theme-preset-card-badge {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-muted, rgba(148, 163, 184, 0.45)));
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.theme-preset-preview {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.theme-preset-swatch {
  display: block;
  width: 100%;
  height: 28px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--theme-border-default, #334155) 75%, transparent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.theme-preset-card-description {
  font-size: 11px;
  line-height: 1.5;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.theme-preset-remove {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--theme-text-danger, #fca5a5);
  font-size: 11px;
  cursor: pointer;
}

.theme-preset-remove:hover {
  text-decoration: underline;
}

.theme-management-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}

.theme-management-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.theme-current-profile {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.theme-current-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
  white-space: nowrap;
}

.theme-current-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.theme-action-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.theme-action-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 4px;
  border-top: 1px solid var(--theme-modal-border, var(--theme-border-default, rgba(51, 65, 85, 0.4)));
}

.theme-import-button {
  position: relative;
  overflow: hidden;
}

.theme-import-button.is-disabled {
  opacity: 0.7;
  cursor: progress;
}

.theme-import-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.theme-import-hint {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.theme-import-schema-links {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.theme-schema-link {
  font-size: 11px;
  color: var(--theme-accent-primary, #60a5fa);
  text-decoration: none;
}

.theme-schema-link:hover {
  text-decoration: underline;
}

.theme-import-error {
  font-size: 11px;
  color: var(--theme-text-danger, #fca5a5);
}



.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.setting-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.setting-description {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
}

.number-setting-group {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}

.font-setting-controls {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}

.font-setting-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.font-setting-section-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
}

.font-preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ui-action-gap);
  --ui-chip-border-neutral: var(--theme-modal-border, var(--theme-border-muted, rgba(148, 163, 184, 0.65)));
  --ui-chip-bg-neutral: var(--theme-modal-control-bg, var(--theme-surface-chip, rgba(15, 23, 42, 0.75)));
  --ui-chip-bg-hover: var(--theme-modal-active-bg, var(--theme-surface-chip-hover, rgba(30, 41, 59, 0.92)));
  --ui-chip-fg-neutral: var(--theme-modal-text, var(--theme-text-primary, #bfdbfe));
}

.font-preset-chip {
  height: var(--ui-chip-height);
  border: 1px solid var(--ui-chip-border-neutral);
  border-radius: var(--ui-chip-radius);
  background: var(--ui-chip-bg-neutral);
  color: var(--ui-chip-fg-neutral);
  font-family: var(--ui-chip-font-family);
  font-size: var(--ui-chip-font-size);
  font-weight: 600;
  letter-spacing: var(--ui-chip-letter-spacing);
  padding: 0 var(--ui-chip-padding-x);
  white-space: nowrap;
  cursor: pointer;
}

.font-preset-chip:hover {
  background: var(--ui-chip-bg-hover);
}

.font-preset-chip.is-active {
  border-color: var(--theme-modal-accent, var(--theme-border-accent, rgba(59, 130, 246, 0.45)));
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-active, rgba(59, 130, 246, 0.2)));
  color: var(--theme-modal-active-text, var(--theme-text-primary, #dbeafe));
}

.number-input {
  width: 84px;
  height: 30px;
  border: 1px solid var(--ui-form-control-border);
  border-radius: 6px;
  background: var(--ui-form-control-bg);
  color: var(--ui-form-control-text);
  font-size: 12px;
  font-family: inherit;
  text-align: right;
  padding: 0 8px;
}

.number-input:focus {
  outline: none;
  border-color: var(--ui-form-control-focus-border);
  box-shadow: var(--ui-form-control-focus-ring);
}

.number-input::-webkit-outer-spin-button,
.number-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.number-input {
  -moz-appearance: textfield;
}

.font-stack-input {
  width: 100%;
  min-width: 0;
  min-height: 72px;
  resize: vertical;
  border: 1px solid var(--ui-form-control-border);
  border-radius: 8px;
  background: var(--ui-form-control-bg);
  color: var(--ui-form-control-text);
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
  padding: 8px 10px;
}

.font-stack-input:focus {
  outline: none;
  border-color: var(--ui-form-control-focus-border);
  box-shadow: var(--ui-form-control-focus-ring);
}

.font-stack-input::placeholder {
  color: var(--ui-form-control-placeholder);
}

.font-discovery-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--ui-form-button-border);
  border-radius: 8px;
  background: var(--ui-form-button-bg);
  color: var(--ui-form-button-text);
  font-size: 12px;
  font-family: inherit;
  padding: 9px 10px;
  cursor: pointer;
}

.font-discovery-toggle:hover {
  border-color: var(--ui-form-control-focus-border);
  background: var(--ui-form-button-hover-bg);
}

.font-discovery-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
}

.font-stack-status-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.font-stack-status-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  background: var(--theme-modal-control-bg, var(--theme-surface-chip, rgba(15, 23, 42, 0.78)));
  font-size: 11px;
}

.font-stack-status-item.is-available {
  border-color: rgba(34, 197, 94, 0.4);
  color: #bbf7d0;
}

.font-stack-status-item.is-missing {
  border-color: rgba(248, 113, 113, 0.4);
  color: #fecaca;
}

.font-stack-status-item.is-generic {
  border-color: rgba(148, 163, 184, 0.45);
  color: #cbd5e1;
}

.font-stack-status-name {
  color: inherit;
}

.font-stack-status-value {
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.font-system-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.font-system-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: flex-start;
  min-height: 30px;
  border: 1px solid var(--ui-form-button-border);
  border-radius: 8px;
  background: var(--ui-form-button-bg);
  color: var(--ui-form-button-text);
  font-size: 12px;
  font-family: inherit;
  padding: 0 10px;
  cursor: pointer;
}

.font-system-button:hover:not(:disabled) {
  border-color: var(--ui-form-control-focus-border);
  background: var(--ui-form-button-hover-bg);
}

.font-system-button:disabled {
  opacity: 0.6;
  cursor: progress;
}

.font-system-hint,
.font-system-error {
  font-size: 11px;
  line-height: 1.45;
}

.font-system-hint {
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.font-system-error {
  color: var(--theme-text-danger, #fca5a5);
}

.font-system-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
}

.font-system-item {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 8px;
  background: var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72)));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  text-align: left;
  cursor: pointer;
}

.font-system-item:hover {
  border-color: var(--theme-modal-accent, var(--theme-border-strong, #475569));
  background: var(--theme-modal-active-bg, var(--theme-surface-panel-hover, rgba(30, 41, 59, 0.92)));
}

.font-system-family {
  font-size: 12px;
  font-weight: 600;
  word-break: break-word;
}

.font-system-meta {
  font-size: 10px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.language-select {
  height: 30px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 6px;
  background: var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.6)));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  font-size: 12px;
  font-family: inherit;
  padding: 0 8px;
  cursor: pointer;
}

.language-select:focus {
  outline: none;
  border-color: var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6)) 55%, transparent);
}


.toggle-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
}

.toggle-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-track {
  width: 36px;
  height: 20px;
  background: var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 10px;
  position: relative;
  transition: background 0.2s;
}

.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--theme-modal-text, var(--theme-text-muted, #94a3b8));
  transition:
    transform 0.2s,
    background 0.2s;
}

.toggle-input:checked + .toggle-track {
  background: var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6));
}

.toggle-input:checked + .toggle-track::after {
  transform: translateX(16px);
  background: var(--theme-modal-active-text, var(--theme-text-inverse, #fff));
}

.theme-region-colors {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  width: 100%;
}

.theme-color-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.theme-color-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
}

.theme-color-input {
  width: 100%;
  height: 32px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
</style>
