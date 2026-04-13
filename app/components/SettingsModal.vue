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

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">{{ $t('settings.theme.presetLabel') }}</div>
            </div>
            <select v-model="selectedPreset" class="language-select">
              <option value="default">Default</option>
              <option value="ocean">Ocean</option>
              <option value="forest">Forest</option>
              <option value="sakura">樱粉幻梦</option>
              <option value="custom">{{ $t('settings.theme.customLabel') }}</option>
            </select>
          </div>

          <template v-if="selectedPreset === 'custom'">
            <div
              v-for="region in regionNames"
              :key="region"
              class="setting-row setting-row-font"
            >
              <div class="setting-info">
                <div class="setting-label">{{ $t(`settings.theme.${region}`) }}</div>
              </div>
              <div class="theme-region-colors">
                <div
                  v-for="field in regionVisibleFields[region]"
                  :key="field"
                  class="theme-color-field"
                >
                  <label class="theme-color-label">{{ $t(`settings.theme.${field}`) }}</label>
                  <input
                    v-model="customColors[region][field]"
                    type="color"
                    class="theme-color-input"
                  />
                </div>
              </div>
            </div>
          </template>

          <div class="setting-row setting-row-font">
            <button
              type="button"
              class="font-system-button"
              @click="resetTheme(); selectedPreset = 'default'"
            >
              {{ $t('settings.theme.reset') }}
            </button>
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
import { computed, onMounted, onUnmounted, reactive, ref, watch, watchEffect } from 'vue';
import { Icon } from '@iconify/vue';
import { useSettings } from '../composables/useSettings';
import { useI18n } from 'vue-i18n';
import { getLocale, setLocale } from '../i18n';
import type { Locale } from '../i18n/types';
import {
  inspectFontStack,
  loadLocalFontFamilies,
  prependFontFamilyToStack,
  supportsLocalFontAccess,
  type FontAvailabilityStatus,
  type LocalFontFamily,
} from '../utils/fontDiscovery';
import {
  DEFAULT_REGION_THEME,
  REGION_COLOR_FIELDS,
  REGION_NAMES,
  REGION_THEME_EDITOR_FALLBACKS,
  resolveRegionThemePresetName,
  resolveRegionThemePreset,
} from '../utils/regionTheme';
import type { RegionColors, RegionName, RegionThemeConfig, RegionThemePresetName } from '../utils/regionTheme';

type FontPreset = {
  id: string;
  label: string;
  value: string;
};

type SettingsPage = 'root' | 'fonts' | 'theme';

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
const {
  enterToSend,
  showMinimizeButtons,
  dockAlwaysOpen,
  pinnedSessionsLimit,
  terminalFontFamily,
  appMonospaceFontFamily,
  regionTheme,
  minPinnedSessionsLimit,
  maxPinnedSessionsLimit,
  defaultTerminalFontFamily,
  defaultAppMonospaceFontFamily,
} = useSettings();
const activeTheme = regionTheme;
const selectedPreset = ref<RegionThemePresetName | 'custom'>('default');
const regionNames: RegionName[] = REGION_NAMES;
const colorFields: (keyof RegionColors)[] = REGION_COLOR_FIELDS;
let customThemeSyncFrame = 0;
let isSyncingThemeEditorState = false;

type EditableRegionColors = Record<keyof RegionColors, string>;

function createEditableRegionColors(): EditableRegionColors {
  return { ...REGION_THEME_EDITOR_FALLBACKS };
}

function createEditableThemeState() {
  return Object.fromEntries(regionNames.map((region) => [region, createEditableRegionColors()])) as Record<RegionName, EditableRegionColors>;
}

function toThemeRegions() {
  return Object.fromEntries(regionNames.map((region) => [region, { ...customColors[region] }])) as Record<RegionName, Partial<RegionColors>>;
}

const regionVisibleFields: Record<RegionName, (keyof RegionColors)[]> = {
  topPanel: colorFields,
  sidePanel: colorFields,
  inputPanel: colorFields,
  outputPanel: colorFields,
  topDropdown: colorFields,
  modalPanel: colorFields,
  pageBackground: ['bg'],
  chatCard: ['bg', 'border', 'textMuted'],
};

const customColors = reactive<Record<RegionName, EditableRegionColors>>(createEditableThemeState());

function syncCustomColorsFromActiveTheme() {
  const source = resolveRegionThemePreset(activeTheme.value?.name) ?? activeTheme.value ?? DEFAULT_REGION_THEME;

  regionNames.forEach((region) => {
    colorFields.forEach((field) => {
      customColors[region][field] = source.regions[region]?.[field] ?? REGION_THEME_EDITOR_FALLBACKS[field];
    });
  });
}

function syncSelectedPresetFromActiveTheme() {
  const activePresetName = resolveRegionThemePresetName(activeTheme.value?.name);

  if (!activeTheme.value || activePresetName === 'default') {
    selectedPreset.value = 'default';
    return;
  }

  if (activePresetName) {
    selectedPreset.value = activePresetName;
    return;
  }

  selectedPreset.value = 'custom';
}

function syncThemeEditorState() {
  isSyncingThemeEditorState = true;
  try {
    syncCustomColorsFromActiveTheme();
    syncSelectedPresetFromActiveTheme();
  } finally {
    isSyncingThemeEditorState = false;
  }
}

function buildCustomTheme(): RegionThemeConfig {
  return {
    name: 'custom',
    label: 'Custom',
    regions: toThemeRegions(),
  };
}

function applyPreset(name: RegionThemePresetName) {
  activeTheme.value = name === DEFAULT_REGION_THEME.name ? null : resolveRegionThemePreset(name);
}

function resetTheme() {
  activeTheme.value = null;
}

function syncCustomThemeNow() {
  customThemeSyncFrame = 0;
  if (selectedPreset.value !== 'custom') return;
  activeTheme.value = buildCustomTheme();
}

function scheduleCustomThemeSync() {
  if (typeof window === 'undefined') {
    syncCustomThemeNow();
    return;
  }
  if (customThemeSyncFrame) {
    window.cancelAnimationFrame(customThemeSyncFrame);
  }
  customThemeSyncFrame = window.requestAnimationFrame(syncCustomThemeNow);
}

watch(selectedPreset, (val) => {
  if (isSyncingThemeEditorState) {
    return;
  }

  if (val === 'custom') {
    isSyncingThemeEditorState = true;
    try {
      syncCustomColorsFromActiveTheme();
    } finally {
      isSyncingThemeEditorState = false;
    }
    activeTheme.value = buildCustomTheme();
  } else if (val === DEFAULT_REGION_THEME.name) {
    resetTheme();
  } else {
    applyPreset(val);
  }
});

watch(
  customColors,
  () => {
    if (selectedPreset.value === 'custom' && !isSyncingThemeEditorState) {
      scheduleCustomThemeSync();
    }
  },
  { deep: true },
);

onUnmounted(() => {
  if (customThemeSyncFrame) {
    window.cancelAnimationFrame(customThemeSyncFrame);
    customThemeSyncFrame = 0;
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
  background: var(--region-modal-active-bg, rgba(2, 6, 23, 0.65));
}

.modal {
  width: min(760px, 96vw);
  max-height: min(88vh, 920px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--region-modal-bg, rgba(15, 23, 42, 0.98));
  border: 1px solid var(--region-modal-border, #334155);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  color: var(--region-modal-text, #e2e8f0);
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
  border: 1px solid var(--region-modal-border, #334155);
  border-radius: 6px;
  background: var(--region-modal-control-bg, transparent);
  color: var(--region-modal-text, #94a3b8);
  cursor: pointer;
}

.modal-back-button:hover,
.modal-close-button:hover {
  background: var(--region-modal-active-bg, #1e293b);
  color: var(--region-modal-text, #e2e8f0);
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
  border: 1px solid var(--region-modal-border, #1e293b);
  border-radius: 8px;
  background: var(--region-modal-control-bg, rgba(2, 6, 23, 0.45));
}

.setting-row-stack {
  align-items: flex-start;
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
  border: 1px solid var(--region-modal-border, #334155);
  text-align: left;
  cursor: pointer;
}

.setting-link-row:hover {
  background: var(--region-modal-active-bg, rgba(15, 23, 42, 0.72));
  border-color: var(--region-modal-accent, #475569);
}

.setting-link-icon {
  flex: 0 0 auto;
  color: var(--region-modal-text-muted, #64748b);
}

.setting-page-description {
  margin: 2px 2px 0;
  color: var(--region-modal-text-muted, #64748b);
  font-size: 11px;
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
  color: var(--region-modal-text, #e2e8f0);
}

.setting-description {
  font-size: 11px;
  color: var(--region-modal-text-muted, #64748b);
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
  color: var(--region-modal-text-muted, #64748b);
}

.font-preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ui-action-gap);
  --ui-chip-border-neutral: var(--region-modal-border, rgba(148, 163, 184, 0.65));
  --ui-chip-bg-neutral: var(--region-modal-control-bg, rgba(15, 23, 42, 0.75));
  --ui-chip-bg-hover: var(--region-modal-active-bg, rgba(30, 41, 59, 0.92));
  --ui-chip-fg-neutral: var(--region-modal-text, #bfdbfe);
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
  border-color: var(--region-modal-accent, rgba(59, 130, 246, 0.45));
  background: var(--region-modal-active-bg, rgba(59, 130, 246, 0.2));
  color: var(--region-modal-active-text, #dbeafe);
}

.number-input {
  width: 84px;
  height: 30px;
  border: 1px solid var(--region-modal-border, #334155);
  border-radius: 6px;
  background: var(--region-modal-control-bg, rgba(2, 6, 23, 0.6));
  color: var(--region-modal-text, #e2e8f0);
  font-size: 12px;
  font-family: inherit;
  text-align: right;
  padding: 0 8px;
}

.number-input:focus {
  outline: none;
  border-color: var(--region-modal-accent, #3b82f6);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--region-modal-accent, #3b82f6) 55%, transparent);
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
  border: 1px solid var(--region-modal-border, #334155);
  border-radius: 8px;
  background: var(--region-modal-control-bg, rgba(2, 6, 23, 0.6));
  color: var(--region-modal-text, #e2e8f0);
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
  padding: 8px 10px;
}

.font-stack-input:focus {
  outline: none;
  border-color: var(--region-modal-accent, #3b82f6);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--region-modal-accent, #3b82f6) 55%, transparent);
}

.font-stack-input::placeholder {
  color: var(--region-modal-text-muted, #475569);
}

.font-discovery-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--region-modal-border, #334155);
  border-radius: 8px;
  background: var(--region-modal-control-bg, rgba(15, 23, 42, 0.72));
  color: var(--region-modal-text, #cbd5e1);
  font-size: 12px;
  font-family: inherit;
  padding: 9px 10px;
  cursor: pointer;
}

.font-discovery-toggle:hover {
  border-color: var(--region-modal-accent, #475569);
  background: var(--region-modal-active-bg, rgba(30, 41, 59, 0.92));
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
  border: 1px solid var(--region-modal-border, #334155);
  background: var(--region-modal-control-bg, rgba(15, 23, 42, 0.78));
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
  color: var(--region-modal-text-muted, #94a3b8);
}

.font-system-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.font-system-button {
  align-self: flex-start;
  min-height: 30px;
  border: 1px solid var(--region-modal-border, #334155);
  border-radius: 8px;
  background: var(--region-modal-control-bg, rgba(15, 23, 42, 0.72));
  color: var(--region-modal-text, #e2e8f0);
  font-size: 12px;
  font-family: inherit;
  padding: 0 10px;
  cursor: pointer;
}

.font-system-button:hover:not(:disabled) {
  border-color: var(--region-modal-accent, #475569);
  background: var(--region-modal-active-bg, rgba(30, 41, 59, 0.92));
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
  color: var(--region-modal-text-muted, #94a3b8);
}

.font-system-error {
  color: #fca5a5;
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
  border: 1px solid var(--region-modal-border, #334155);
  border-radius: 8px;
  background: var(--region-modal-control-bg, rgba(15, 23, 42, 0.72));
  color: var(--region-modal-text, #e2e8f0);
  text-align: left;
  cursor: pointer;
}

.font-system-item:hover {
  border-color: var(--region-modal-accent, #475569);
  background: var(--region-modal-active-bg, rgba(30, 41, 59, 0.92));
}

.font-system-family {
  font-size: 12px;
  font-weight: 600;
  word-break: break-word;
}

.font-system-meta {
  font-size: 10px;
  color: var(--region-modal-text-muted, #94a3b8);
}

.language-select {
  height: 30px;
  border: 1px solid var(--region-modal-border, #334155);
  border-radius: 6px;
  background: var(--region-modal-control-bg, rgba(2, 6, 23, 0.6));
  color: var(--region-modal-text, #e2e8f0);
  font-size: 12px;
  font-family: inherit;
  padding: 0 8px;
  cursor: pointer;
}

.language-select:focus {
  outline: none;
  border-color: var(--region-modal-accent, #3b82f6);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--region-modal-accent, #3b82f6) 55%, transparent);
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
  background: var(--region-modal-border, #334155);
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
  background: var(--region-modal-text, #94a3b8);
  border-radius: 50%;
  transition:
    transform 0.2s,
    background 0.2s;
}

.toggle-input:checked + .toggle-track {
  background: var(--region-modal-accent, #3b82f6);
}

.toggle-input:checked + .toggle-track::after {
  transform: translateX(16px);
  background: var(--region-modal-active-text, #fff);
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
  color: var(--region-modal-text-muted, #64748b);
}

.theme-color-input {
  width: 100%;
  height: 32px;
  border: 1px solid var(--region-modal-border, #334155);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
</style>
