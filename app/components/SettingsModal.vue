<template>
  <dialog ref="dialogRef" class="modal-backdrop" @close="$emit('close')" @cancel.prevent>
    <div class="modal">
      <header class="modal-header">
        <div class="modal-header-main">
          <button
            v-if="activePage !== 'root'"
            type="button"
            class="modal-back-button"
            :aria-label="$t('settings.backToRoot')"
            @click="goBackInSettings"
          >
            <Icon icon="lucide:arrow-left" :width="14" :height="14" />
          </button>
          <div class="modal-title">{{ pageTitle }}</div>
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
      <div ref="modalBody" class="modal-body">
        <template v-if="activePage === 'root'">
          <SettingRow
            :label="$t('settings.language.label')"
            :description="$t('settings.language.description')"
          >
            <select v-model="locale" class="language-select">
              <option value="en">{{ $t('settings.language.en') }}</option>
              <option value="zh-CN">{{ $t('settings.language.zhCN') }}</option>
              <option value="zh-TW">{{ $t('settings.language.zhTW') }}</option>
              <option value="ja">{{ $t('settings.language.ja') }}</option>
              <option value="eo">{{ $t('settings.language.eo') }}</option>
            </select>
          </SettingRow>

          <ToggleSettingRow
            v-model="enterToSend"
            :label="$t('settings.enterToSend.label')"
            :description="$t('settings.enterToSend.description')"
          />

          <ToggleSettingRow
            v-model="showMinimizeButtons"
            :label="$t('settings.showMinimizeButtons.label')"
            :description="$t('settings.showMinimizeButtons.description')"
          />

          <ToggleSettingRow
            v-model="dockAlwaysOpen"
            :label="$t('settings.dockAlwaysOpen.label')"
            :description="$t('settings.dockAlwaysOpen.description')"
            :class="{ 'setting-row-disabled': !showMinimizeButtons }"
            :title="
              showMinimizeButtons
                ? $t('settings.dockAlwaysOpen.label')
                : $t('settings.showMinimizeButtons.label')
            "
            :disabled="!showMinimizeButtons"
          />

          <ToggleSettingRow
            v-model="showOpenInEditorButton"
            :label="$t('settings.showOpenInEditorButton.label')"
            :description="$t('settings.showOpenInEditorButton.description')"
          />

          <SettingRow
            :label="$t('settings.openInEditorMaxSizeMb.label')"
            :description="$t('settings.openInEditorMaxSizeMb.description')"
            class="setting-row-stack"
          >
            <div class="number-setting-group">
              <input
                v-model.number="openInEditorMaxSizeMb"
                type="number"
                class="number-input"
                :min="minOpenInEditorMaxSizeMb"
                :max="maxOpenInEditorMaxSizeMb"
                step="1"
                @blur="clampOpenInEditorMaxSizeMb"
                @keydown.enter="clampOpenInEditorMaxSizeMb"
              />
            </div>
          </SettingRow>

          <ToggleSettingRow
            v-model="floatingPreviewWordWrap"
            :label="$t('settings.floatingPreviewWordWrap.label')"
            :description="$t('settings.floatingPreviewWordWrap.description')"
          />

          <SettingRow
            tag="button"
            type="button"
            class="setting-link-row"
            :label="$t('settings.editor.label')"
            :description="$t('settings.editor.description')"
            :aria-label="$t('settings.editor.label')"
            @click="activePage = 'editor'"
          >
            <Icon icon="lucide:chevron-right" :width="16" :height="16" class="setting-link-icon" />
          </SettingRow>

          <SettingRow
            tag="button"
            type="button"
            class="setting-link-row"
            :label="$t('settings.textTransformers.label')"
            :description="$t('settings.textTransformers.description')"
            :aria-label="$t('settings.textTransformers.label')"
            @click="activePage = 'transformers'"
          >
            <Icon icon="lucide:chevron-right" :width="16" :height="16" class="setting-link-icon" />
          </SettingRow>

          <SettingRow
            tag="button"
            type="button"
            class="setting-link-row"
            :label="$t('settings.fontSettings.label')"
            :description="$t('settings.fontSettings.description')"
            :aria-label="$t('settings.fontSettings.label')"
            @click="activePage = 'fonts'"
          >
            <Icon icon="lucide:chevron-right" :width="16" :height="16" class="setting-link-icon" />
          </SettingRow>

          <SettingRow
            tag="button"
            type="button"
            class="setting-link-row"
            :label="$t('settings.experimentalFeatures.label')"
            :description="$t('settings.experimentalFeatures.description')"
            :aria-label="$t('settings.experimentalFeatures.label')"
            @click="activePage = 'experimental'"
          >
            <Icon icon="lucide:chevron-right" :width="16" :height="16" class="setting-link-icon" />
          </SettingRow>

          <SettingRow
            tag="button"
            type="button"
            class="setting-link-row"
            :label="$t('settings.theme.label')"
            :description="$t('settings.theme.description')"
            :aria-label="$t('settings.theme.label')"
            @click="activePage = 'theme'"
          >
            <Icon icon="lucide:chevron-right" :width="16" :height="16" class="setting-link-icon" />
          </SettingRow>
        </template>

        <template v-else-if="activePage === 'transformers'">
          <div
            v-if="editingTextTransformer"
            class="setting-row setting-row-stack transformer-detail"
          >
            <div class="transformer-detail-header">
              <span class="transformer-detail-status">
                {{ $t('settings.textTransformers.autoSave') }}
              </span>
            </div>
            <div class="transformer-row-grid">
              <label class="transformer-field">
                <span class="transformer-field-label">
                  {{ $t('settings.textTransformers.sequenceLabel') }}
                </span>
                <input
                  :id="textTransformerTriggerInputId(editingTextTransformerIndex)"
                  :value="editingTextTransformer.trigger"
                  data-snippet-field="trigger"
                  type="text"
                  class="transformer-input"
                  spellcheck="false"
                  autocomplete="off"
                  :placeholder="$t('settings.textTransformers.sequencePlaceholder')"
                  :aria-invalid="Boolean(textTransformerTriggerError(editingTextTransformerIndex))"
                  :aria-describedby="
                    textTransformerTriggerError(editingTextTransformerIndex)
                      ? textTransformerTriggerErrorId(editingTextTransformerIndex)
                      : undefined
                  "
                  @input="updateTextTransformerField(editingTextTransformer.id, 'trigger', $event)"
                />
                <span
                  v-if="textTransformerTriggerError(editingTextTransformerIndex)"
                  :id="textTransformerTriggerErrorId(editingTextTransformerIndex)"
                  class="transformer-error"
                >
                  {{ textTransformerTriggerError(editingTextTransformerIndex) }}
                </span>
              </label>
              <label class="transformer-field">
                <span class="transformer-field-label">{{ $t('settings.textTransformers.nameLabel') }}</span>
                <input
                  :value="editingTextTransformer.name"
                  data-snippet-field="name"
                  type="text"
                  class="transformer-input"
                  autocomplete="off"
                  :placeholder="$t('settings.textTransformers.namePlaceholder')"
                  @input="updateTextTransformerField(editingTextTransformer.id, 'name', $event)"
                />
              </label>
              <label class="transformer-field">
                <span class="transformer-field-label">
                  {{ $t('settings.textTransformers.descriptionLabel') }}
                </span>
                <input
                  :value="editingTextTransformer.description ?? ''"
                  data-snippet-field="description"
                  type="text"
                  class="transformer-input"
                  autocomplete="off"
                  :placeholder="$t('settings.textTransformers.descriptionPlaceholder')"
                  @input="updateTextTransformerField(editingTextTransformer.id, 'description', $event)"
                />
              </label>
              <label class="transformer-field">
                <span class="transformer-field-label">{{ $t('settings.textTransformers.tagsLabel') }}</span>
                <input
                  :value="textTransformerTagText(editingTextTransformer)"
                  data-snippet-field="tags"
                  type="text"
                  class="transformer-input"
                  autocomplete="off"
                  :placeholder="$t('settings.textTransformers.tagsPlaceholder')"
                  @input="updateTextTransformerTags(editingTextTransformer.id, $event)"
                />
              </label>
              <label class="transformer-field transformer-field-body">
                <span class="transformer-field-label">{{ $t('settings.textTransformers.bodyLabel') }}</span>
                <textarea
                  :value="editingTextTransformer.body"
                  data-snippet-field="body"
                  class="transformer-input transformer-body"
                  rows="7"
                  spellcheck="false"
                  :placeholder="$t('settings.textTransformers.bodyPlaceholder')"
                  @input="updateTextTransformerField(editingTextTransformer.id, 'body', $event)"
                />
                <span class="transformer-variable-help">
                  <span>{{ $t('settings.textTransformers.variablesLabel') }}</span>
                  <code v-for="variable in textTransformerVariables" :key="variable">
                    {{ variable }}
                  </code>
                </span>
              </label>
            </div>
          </div>

          <template v-else>
            <div class="setting-page-description">
              {{ $t('settings.textTransformers.pageDescription') }}
            </div>
            <ToggleSettingRow
              v-model="textTransformersEnabled"
              :label="$t('settings.textTransformers.enabledLabel')"
              :description="$t('settings.textTransformers.enabledDescription')"
              :label-id="textTransformerToggleLabelId"
              :description-id="textTransformerToggleDescriptionId"
              :aria-labelledby="textTransformerToggleLabelId"
              :aria-describedby="textTransformerToggleDescriptionId"
            />
            <div class="setting-row setting-row-stack transformer-settings-section">
              <div class="transformer-heading">
                <div class="setting-info">
                  <div class="setting-label">{{ $t('settings.textTransformers.mappingLabel') }}</div>
                  <div class="setting-description">
                    {{ $t('settings.textTransformers.mappingDescription') }}
                  </div>
                </div>
                <button
                  type="button"
                  class="font-system-button transformer-add"
                  @click="addTextTransformer"
                >
                  {{ $t('settings.textTransformers.add') }}
                </button>
              </div>
              <div class="transformer-toolbar">
                <div
                  v-if="transformerTagFilters.length > 0"
                  class="transformer-tag-filters"
                  role="group"
                  :aria-label="$t('settings.textTransformers.filterByTag')"
                >
                  <button
                    type="button"
                    class="transformer-tag-filter"
                    :class="{ 'is-active': activeTagFilter === null }"
                    :aria-pressed="activeTagFilter === null"
                    @click="activeTagFilter = null"
                  >
                    {{ $t('settings.textTransformers.allTags') }}
                  </button>
                  <button
                    v-for="tag in transformerTagFilters"
                    :key="tag"
                    type="button"
                    class="transformer-tag-filter"
                    :class="{ 'is-active': activeTagFilter === tag }"
                    :aria-pressed="activeTagFilter === tag"
                    @click="toggleTagFilter(tag)"
                  >
                    {{ tag }}
                  </button>
                </div>
                <div class="transformer-actions">
                  <label class="font-system-button transformer-import-button">
                    <input
                      class="transformer-import-input"
                      type="file"
                      accept="application/json,.json"
                      :aria-label="$t('settings.textTransformers.importAction')"
                      @change="importTextTransformers"
                    />
                    {{ $t('settings.textTransformers.importAction') }}
                  </label>
                  <button
                    type="button"
                    class="font-system-button transformer-export"
                    @click="exportTextTransformers"
                  >
                    {{ $t('settings.textTransformers.exportAction') }}
                  </button>
                </div>
              </div>
              <div
                class="transformer-import-status"
                :class="textTransformerImportStatus ? `is-${textTransformerImportStatus.kind}` : ''"
                role="status"
                aria-live="polite"
              >
                {{ textTransformerImportStatus?.message }}
              </div>
              <div v-if="visibleTextTransformers.length === 0" class="transformer-empty">
                {{ transformerEmptyText }}
              </div>
              <div v-else class="transformer-list">
                <div
                  v-for="entry in visibleTextTransformers"
                  :key="entry.snippet.id"
                  class="transformer-row"
                  :class="{ 'is-disabled': !entry.snippet.enabled }"
                >
                  <SnippetCompletion
                    :snippet="entry.snippet"
                    :sequence="textTransformerDisplayTrigger(entry.snippet)"
                  />
                  <div class="transformer-row-actions">
                    <button
                      type="button"
                      class="transformer-action-button transformer-enable"
                      :class="{ 'is-active': entry.snippet.enabled }"
                      :disabled="Boolean(textTransformerTriggerError(entry.index))"
                      :aria-label="
                        textTransformerTriggerError(entry.index) ||
                        $t(
                          entry.snippet.enabled
                            ? 'settings.textTransformers.disableAction'
                            : 'settings.textTransformers.enableAction',
                          { name: textTransformerTitle(entry.snippet) },
                        )
                      "
                      :aria-pressed="entry.snippet.enabled"
                      :title="
                        textTransformerTriggerError(entry.index) ||
                        $t(
                          entry.snippet.enabled
                            ? 'settings.textTransformers.disableAction'
                            : 'settings.textTransformers.enableAction',
                          { name: textTransformerTitle(entry.snippet) },
                        )
                      "
                      @click="toggleTextTransformerEnabled(entry.snippet.id)"
                    >
                      <Icon
                        :icon="entry.snippet.enabled ? 'lucide:circle-check' : 'lucide:circle'"
                        :width="16"
                        :height="16"
                      />
                    </button>
                    <button
                      type="button"
                      class="transformer-action-button transformer-remove"
                      :aria-label="$t('settings.textTransformers.remove')"
                      :title="$t('settings.textTransformers.remove')"
                      @click="removeTextTransformer(entry.snippet.id)"
                    >
                      <Icon icon="lucide:trash-2" :width="16" :height="16" />
                    </button>
                    <button
                      type="button"
                      class="transformer-action-button transformer-edit"
                      :aria-label="$t('settings.textTransformers.editAction', { name: textTransformerTitle(entry.snippet) })"
                      :title="$t('settings.textTransformers.editAction', { name: textTransformerTitle(entry.snippet) })"
                      @click="editingTextTransformerId = entry.snippet.id"
                    >
                      <Icon icon="lucide:pencil" :width="16" :height="16" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </template>

        <template v-else-if="activePage === 'theme'">
          <div class="setting-page-description">{{ $t('settings.theme.description') }}</div>

          <SettingRow
            :label="$t('settings.theme.presetLabel')"
            :description="$t('settings.theme.presetDescription')"
            class="setting-row-stack theme-settings-section"
          >
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
          </SettingRow>

          <SettingRow
            :label="$t('settings.theme.managementLabel')"
            :description="$t('settings.theme.managementDescription')"
            class="setting-row-stack theme-settings-section"
          >
            <div class="theme-management-area">
              <div class="theme-management-top">
                <div class="theme-current-profile">
                  <span class="theme-current-label">{{
                    $t('settings.theme.currentProfileLabel')
                  }}</span>
                  <span class="theme-current-value">{{ activeThemeSummary }}</span>
                </div>
                <div class="theme-action-bar">
                  <label
                    class="font-system-button theme-import-button"
                    :class="{ 'is-disabled': isImportingTheme }"
                  >
                    <input
                      class="theme-import-input"
                      type="file"
                      accept="application/json"
                      :disabled="isImportingTheme"
                      @change="importThemeFile"
                    />
                    {{
                      isImportingTheme
                        ? $t('settings.theme.importing')
                        : $t('settings.theme.importAction')
                    }}
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
                <a
                  class="theme-schema-link"
                  :href="themeSchemaUrl"
                  target="_blank"
                  rel="noreferrer"
                >
                  {{ $t('settings.theme.schemaLink') }}
                </a>
              </div>
              <div v-if="themeImportError" class="theme-import-error">{{ themeImportError }}</div>
            </div>
          </SettingRow>
        </template>

        <template v-else-if="activePage === 'editor'">
          <div class="setting-page-description">{{ $t('settings.editor.pageDescription') }}</div>

          <label class="setting-row setting-row-stack">
            <span class="setting-info">
              <span class="setting-label">{{ $t('settings.editor.tabSize.label') }}</span>
              <span class="setting-description">{{
                $t('settings.editor.tabSize.description')
              }}</span>
            </span>
            <input
              v-model.number="editorTabSize"
              type="number"
              class="number-input"
              :min="minEditorTabSize"
              :max="maxEditorTabSize"
              step="1"
              @blur="clampEditorTabSize"
              @keydown.enter="clampEditorTabSize"
            />
          </label>

          <ToggleSettingRow
            v-model="editInVis"
            :label="$t('settings.editor.editInVis.label')"
            :description="$t('settings.editor.editInVis.description')"
          />

          <div class="setting-row setting-row-stack editor-shortcut-section">
            <div class="editor-shortcut-heading">
              <div class="setting-label">{{ $t('settings.editor.shortcuts.label') }}</div>
              <button type="button" class="font-system-button" @click="resetEditorShortcuts">
                {{ $t('settings.editor.shortcuts.reset') }}
              </button>
            </div>
            <div class="setting-description editor-shortcut-description">
              {{ $t('settings.editor.shortcuts.description') }}
            </div>
            <div class="editor-shortcut-grid">
              <div
                v-for="field in editorShortcutFields"
                :key="field.key"
                class="editor-shortcut-field"
              >
                <span class="editor-shortcut-label">{{ field.label }}</span>
                <button
                  type="button"
                  class="editor-shortcut-recorder"
                  :class="{
                    'is-recording': recordingShortcut === field.key,
                    'is-invalid': editorShortcutErrors[field.key],
                  }"
                  :aria-label="$t('settings.editor.shortcuts.recordAria', { action: field.label })"
                  :aria-pressed="recordingShortcut === field.key"
                  :aria-invalid="Boolean(editorShortcutErrors[field.key])"
                  @click="beginShortcutRecording(field.key)"
                  @keydown.capture="recordShortcut(field.key, $event)"
                  @blur="cancelShortcutRecording(field.key)"
                >
                  <kbd>{{ shortcutButtonLabel(field.key) }}</kbd>
                </button>
                <span v-if="editorShortcutErrors[field.key]" class="editor-shortcut-error">
                  {{ $t(`settings.editor.shortcuts.${editorShortcutErrors[field.key]}Error`) }}
                </span>
              </div>
            </div>
          </div>

          <SettingRow
            v-if="isElectron"
            :label="$t('settings.editor.localApplication.label')"
            :description="$t('settings.editor.localApplication.description')"
            class="setting-row-stack"
          >
            <div class="local-application-controls">
              <input
                :value="localApplicationPath"
                type="text"
                class="font-stack-input"
                readonly
                spellcheck="false"
                autocomplete="off"
                :placeholder="$t('settings.editor.localApplication.placeholder')"
              />
              <button type="button" class="font-system-button" @click="browseLocalApplication">
                {{ $t('settings.editor.localApplication.browse') }}
              </button>
              <button
                v-if="localApplicationPath"
                type="button"
                class="font-system-button"
                @click="clearLocalApplication"
              >
                {{ $t('settings.editor.localApplication.clear') }}
              </button>
            </div>
            <div v-if="localApplicationError" class="theme-import-error">
              {{ localApplicationError }}
            </div>
          </SettingRow>
        </template>

        <template v-else-if="activePage === 'experimental'">
          <div class="setting-page-description">
            {{ $t('settings.experimentalFeatures.pageDescription') }}
          </div>

          <ToggleSettingRow
            v-model="showCodexButton"
            :label="$t('settings.experimentalFeatures.showCodexButton.label')"
            :description="$t('settings.experimentalFeatures.showCodexButton.description')"
          />

          <ToggleSettingRow
            v-model="showForgePanelButton"
            :label="$t('settings.experimentalFeatures.showForgeButton.label')"
            :description="$t('settings.experimentalFeatures.showForgeButton.description')"
          />

          <ToggleSettingRow
            v-model="showCodexInStatusMonitor"
            :label="$t('settings.experimentalFeatures.showCodexInStatusMonitor.label')"
            :description="$t('settings.experimentalFeatures.showCodexInStatusMonitor.description')"
          />
        </template>

        <template v-else>
          <div class="setting-page-description">{{ $t('settings.fontSettings.description') }}</div>

          <SettingRow
            v-for="section in fontStackSections"
            :key="section.id"
            :label="$t(section.labelKey)"
            :description="$t(section.descriptionKey)"
            class="setting-row-font"
          >
            <div class="font-setting-controls">
              <div v-for="size in section.sizes" :key="size.inputId" class="font-setting-section">
                <label :for="size.inputId" class="font-setting-section-label">{{
                  $t(size.labelKey)
                }}</label>
                <div class="number-setting-group">
                  <input
                    :id="size.inputId"
                    v-model.number="size.model.value"
                    type="number"
                    class="number-input"
                    :min="size.min"
                    :max="size.max"
                    step="1"
                    @blur="size.clamp"
                    @keydown.enter="size.clamp"
                  />
                </div>
                <div class="setting-description" style="margin-top: 2px">
                  {{ $t(size.descriptionKey) }}
                </div>
              </div>
              <div
                v-if="section.editorSuboption"
                class="font-setting-section font-setting-suboption"
              >
                <label class="font-setting-section-label">{{
                  $t('settings.editor.fontSize.label')
                }}</label>
                <div class="editor-number-control">
                  <input
                    v-model.number="editorFontSizePx"
                    type="number"
                    class="number-input"
                    :min="minEditorFontSizePx"
                    :max="maxEditorFontSizePx"
                    :placeholder="$t('settings.editor.fontSize.inherited')"
                    step="1"
                    @blur="clampEditorFontSize"
                    @keydown.enter="clampEditorFontSize"
                  />
                  <button type="button" class="font-system-button" @click="inheritEditorFontSize">
                    {{ $t('settings.editor.fontSize.inheritAction') }}
                  </button>
                </div>
                <div class="setting-description" style="margin-top: 2px">
                  {{ $t('settings.editor.fontSize.description') }}
                </div>
              </div>
              <div class="font-setting-section">
                <div :id="section.presetLabelId" class="font-setting-section-label">
                  {{ $t('settings.fontPresetsLabel') }}
                </div>
                <div class="font-preset-row" role="group" :aria-labelledby="section.presetLabelId">
                  <button
                    v-for="preset in section.presets"
                    :key="preset.id"
                    type="button"
                    class="font-preset-chip"
                    :class="{
                      'is-active': isFontPresetSelected(section.family.value, preset.value),
                    }"
                    :aria-pressed="isFontPresetSelected(section.family.value, preset.value)"
                    @click="section.family.value = preset.value"
                  >
                    {{ preset.label }}
                  </button>
                </div>
              </div>
              <div class="font-setting-section">
                <label
                  :id="section.inputLabelId"
                  class="font-setting-section-label"
                  :for="section.textareaId"
                >
                  {{ $t('settings.customFontStackLabel') }}
                </label>
                <textarea
                  :id="section.textareaId"
                  v-model.trim="section.family.value"
                  class="font-stack-input"
                  rows="3"
                  spellcheck="false"
                  autocapitalize="off"
                  autocomplete="off"
                  :placeholder="section.placeholder"
                  :aria-describedby="section.presetLabelId"
                />
                <div class="font-stack-status-list" role="status" aria-live="polite">
                  <div
                    v-for="entry in section.statusEntries"
                    :key="`${section.id}-${entry.family}`"
                    class="font-stack-status-item"
                    :class="`is-${entry.status}`"
                  >
                    <span class="font-stack-status-name">{{ entry.family }}</span>
                    <span class="font-stack-status-value">{{
                      getFontStatusLabel(entry.status)
                    }}</span>
                  </div>
                </div>
              </div>
              <div class="font-setting-section">
                <button
                  type="button"
                  class="font-discovery-toggle"
                  :aria-expanded="section.discoveryOpen.value"
                  @click="toggleFontDiscovery(section.id)"
                >
                  <span>{{ $t('settings.systemFonts.label') }}</span>
                  <Icon
                    :icon="
                      section.discoveryOpen.value ? 'lucide:chevron-up' : 'lucide:chevron-down'
                    "
                    :width="14"
                    :height="14"
                  />
                </button>
                <div v-if="section.discoveryOpen.value" class="font-discovery-panel">
                  <div class="font-system-actions">
                    <button
                      v-if="supportsLocalFontsApi"
                      type="button"
                      class="font-system-button"
                      :disabled="isLoadingLocalFonts"
                      @click="loadLocalFonts"
                    >
                      {{
                        isLoadingLocalFonts
                          ? $t('settings.systemFonts.loading')
                          : $t('settings.systemFonts.scan')
                      }}
                    </button>
                    <div v-else class="font-system-hint">
                      {{ $t('settings.systemFonts.unsupported') }}
                    </div>
                    <div v-if="localFontsError" class="font-system-error">
                      {{ localFontsError }}
                    </div>
                  </div>
                  <div v-if="localFontFamilies.length > 0" class="font-system-list" role="list">
                    <button
                      v-for="font in localFontFamilies"
                      :key="`${section.id}-${font.family}`"
                      type="button"
                      class="font-system-item"
                      @click="
                        section.family.value = prependFamily(section.family.value, font.family)
                      "
                    >
                      <span class="font-system-family">{{ font.family }}</span>
                      <span class="font-system-meta">{{
                        font.styles.join(', ') || $t('settings.systemFonts.regular')
                      }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </SettingRow>
        </template>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, watchEffect, type Ref } from 'vue';
import { Icon } from '@iconify/vue';
import SettingRow from './SettingRow.vue';
import SnippetCompletion from './SnippetCompletion.vue';
import ToggleSettingRow from './ToggleSettingRow.vue';
import { useSettings } from '../composables/useSettings';
import { getTextTransformerTriggerIssue, textTransformerSequence } from '../utils/textTransformers';
import {
  mergeTextTransformers,
  MAX_TEXT_TRANSFORMER_IMPORT_BYTES,
  MAX_TEXT_TRANSFORMER_IMPORT_COUNT,
  isValidTextTransformerTrigger,
  parseTextTransformerImport,
  TEXT_TRANSFORMER_EXPORT_VERSION,
  type TextTransformer,
  type TextTransformerImportResult,
} from '../utils/snippets';
import { useI18n } from 'vue-i18n';
import { getLocale, setLocale } from '../i18n';
import type { Locale } from '../i18n/types';
import { downloadJsonFile } from '../utils/fileExport';
import { StorageKeys, storageSetJSON } from '../utils/storageKeys';
import {
  formatShortcutForDisplay,
  shortcutFromKeyboardEvent,
  validateEditorShortcutMap,
} from '../utils/editorShortcuts';
import {
  inspectFontStack,
  loadLocalFontFamilies,
  prependFontFamilyToStack,
  supportsLocalFontAccess,
  type FontAvailabilityStatus,
  type LocalFontFamily,
} from '../utils/fontDiscovery';
import { resolveThemeStoragePreset, regionThemeToStorage } from '../utils/themeTokens';
import { DEFAULT_REGION_THEME, resolveRegionThemePresetName } from '../utils/regionTheme';
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

type SettingsPage = 'root' | 'editor' | 'fonts' | 'theme' | 'transformers' | 'experimental';
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
  initialPage?: SettingsPage;
}>();

defineEmits<{
  (event: 'close'): void;
}>();

const { t } = useI18n();
const dialogRef = ref<HTMLDialogElement | null>(null);
const activePage = ref<SettingsPage>('root');
const modalBody = ref<HTMLElement | null>(null);
watch(activePage, async () => {
  await nextTick();
  if (modalBody.value) modalBody.value.scrollTop = 0;
});
const terminalPresetLabelId = 'settings-terminal-font-presets';
const terminalInputLabelId = 'settings-terminal-font-input-label';
const terminalTextareaId = 'settings-terminal-font-input';
const terminalSizeInputId = 'settings-terminal-font-size';
const appPresetLabelId = 'settings-app-font-presets';
const appInputLabelId = 'settings-app-font-input-label';
const appTextareaId = 'settings-app-font-input';
const appSizeInputId = 'settings-app-font-size';
const messageSizeInputId = 'settings-message-font-size';
const sidebarSizeInputId = 'settings-sidebar-font-size';
const uiSizeInputId = 'settings-ui-font-size';
const textTransformerToggleLabelId = 'settings-text-transformers-enabled-label';
const textTransformerToggleDescriptionId = 'settings-text-transformers-enabled-description';
const supportsLocalFontsApi = supportsLocalFontAccess();
const isLoadingLocalFonts = ref(false);
const localFontsError = ref('');
const localFontFamilies = ref<LocalFontFamily[]>([]);
const isTerminalFontDiscoveryOpen = ref(false);
const isAppFontDiscoveryOpen = ref(false);
const themeImportError = ref('');
const isImportingTheme = ref(false);
const isElectron = computed(() => Boolean(window.electronAPI?.localFile));
const localApplicationError = ref('');
const {
  enterToSend,
  showMinimizeButtons,
  showCodexButton,
  showForgePanelButton,
  showCodexInStatusMonitor,
  editInVis,
  dockAlwaysOpen,
  terminalFontFamily,
  appMonospaceFontFamily,
  terminalFontSizePx,
  appFontSizePx,
  messageFontSizePx,
  sidebarFontSizePx,
  uiFontSizePx,
  themeStorage,
  externalThemes,
  defaultTerminalFontFamily,
  defaultAppMonospaceFontFamily,
  minTerminalFontSizePx,
  maxTerminalFontSizePx,
  minAppFontSizePx,
  maxAppFontSizePx,
  minMessageFontSizePx,
  maxMessageFontSizePx,
  minSidebarFontSizePx,
  maxSidebarFontSizePx,
  minUiFontSizePx,
  maxUiFontSizePx,
  showOpenInEditorButton,
  openInEditorMaxSizeMb,
  minOpenInEditorMaxSizeMb,
  maxOpenInEditorMaxSizeMb,
  floatingPreviewWordWrap,
  editorFontSizePx,
  editorTabSize,
  editorShortcuts,
  textTransformersEnabled,
  textTransformers,
  localApplicationPath,
  defaultEditorShortcuts,
  minEditorFontSizePx,
  maxEditorFontSizePx,
  minEditorTabSize,
  maxEditorTabSize,
} = useSettings();
type EditorShortcutKey = keyof typeof defaultEditorShortcuts;
const editorShortcutFields = computed<Array<{ key: EditorShortcutKey; label: string }>>(() => [
  { key: 'save', label: t('settings.editor.shortcuts.save') },
  { key: 'undo', label: t('settings.editor.shortcuts.undo') },
  { key: 'redo', label: t('settings.editor.shortcuts.redo') },
  { key: 'find', label: t('settings.editor.shortcuts.find') },
  { key: 'findNext', label: t('settings.editor.shortcuts.findNext') },
  { key: 'findPrevious', label: t('settings.editor.shortcuts.findPrevious') },
  { key: 'goToLine', label: t('settings.editor.shortcuts.goToLine') },
  { key: 'selectLine', label: t('settings.editor.shortcuts.selectLine') },
  { key: 'autocomplete', label: t('settings.editor.shortcuts.autocomplete') },
  { key: 'indent', label: t('settings.editor.shortcuts.indent') },
  { key: 'outdent', label: t('settings.editor.shortcuts.outdent') },
  { key: 'deleteLine', label: t('settings.editor.shortcuts.deleteLine') },
  { key: 'moveLineUp', label: t('settings.editor.shortcuts.moveLineUp') },
  { key: 'moveLineDown', label: t('settings.editor.shortcuts.moveLineDown') },
  { key: 'duplicateLineUp', label: t('settings.editor.shortcuts.duplicateLineUp') },
  { key: 'duplicateLineDown', label: t('settings.editor.shortcuts.duplicateLineDown') },
  { key: 'toggleLineComment', label: t('settings.editor.shortcuts.toggleLineComment') },
  { key: 'toggleBlockComment', label: t('settings.editor.shortcuts.toggleBlockComment') },
  { key: 'foldCode', label: t('settings.editor.shortcuts.foldCode') },
  { key: 'unfoldCode', label: t('settings.editor.shortcuts.unfoldCode') },
]);
const editorShortcutErrors = computed(() => validateEditorShortcutMap(editorShortcuts.value));
const recordingShortcut = ref<EditorShortcutKey | null>(null);
const activeThemeStorage = themeStorage;
const selectedPreset = ref<string>('default');
let isSyncingThemeEditorState = false;

const themeRegistryEntries = computed<ThemeRegistryEntry[]>(() =>
  listThemeRegistryEntries(externalThemes.value),
);
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
  const presetTheme =
    name === DEFAULT_REGION_THEME.name
      ? null
      : resolveThemeRegistryTheme(name, externalThemes.value);
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
    themeImportError.value =
      error instanceof Error ? error.message : t('settings.theme.importError');
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
    description: entry.descriptionKey
      ? t(entry.descriptionKey)
      : (entry.description ?? t('settings.theme.externalDescription')),
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
    value:
      "'SF Mono', 'SFMono-Regular', ui-monospace, 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', monospace",
  },
  {
    id: 'jetbrains',
    label: t('settings.fontPresets.jetbrainsMono'),
    value:
      "'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', monospace",
  },
  {
    id: 'firacode',
    label: t('settings.fontPresets.firaCode'),
    value:
      "'Fira Code', ui-monospace, 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', monospace",
  },
  {
    id: 'iosevka',
    label: t('settings.fontPresets.iosevkaTerm'),
    value:
      "'Iosevka Term', 'Iosevka Fixed', ui-monospace, 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', monospace",
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

const terminalFontStatusEntries = computed(() =>
  inspectFontStack(debouncedTerminalFontFamily.value).slice(0, 8),
);
const appFontStatusEntries = computed(() =>
  inspectFontStack(debouncedAppMonospaceFontFamily.value).slice(0, 8),
);

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

type FontStatusEntry = ReturnType<typeof inspectFontStack>[number];

type FontSizeField = {
  inputId: string;
  labelKey: string;
  descriptionKey: string;
  model: Ref<number>;
  min: number;
  max: number;
  clamp: () => void;
};

type FontStackSection = {
  id: 'terminal' | 'app';
  labelKey: string;
  descriptionKey: string;
  family: Ref<string>;
  placeholder: string;
  presets: FontPreset[];
  statusEntries: FontStatusEntry[];
  presetLabelId: string;
  inputLabelId: string;
  textareaId: string;
  discoveryOpen: Ref<boolean>;
  sizes: FontSizeField[];
  editorSuboption: boolean;
};

const fontStackSections = computed<FontStackSection[]>(() => [
  {
    id: 'terminal',
    labelKey: 'settings.terminalFontFamily.label',
    descriptionKey: 'settings.terminalFontFamily.description',
    family: terminalFontFamily,
    placeholder: defaultTerminalFontFamily,
    presets: terminalFontPresets.value,
    statusEntries: terminalFontStatusEntries.value,
    presetLabelId: terminalPresetLabelId,
    inputLabelId: terminalInputLabelId,
    textareaId: terminalTextareaId,
    discoveryOpen: isTerminalFontDiscoveryOpen,
    sizes: [
      {
        inputId: terminalSizeInputId,
        labelKey: 'settings.terminalFontSizePx.label',
        descriptionKey: 'settings.terminalFontSizePx.description',
        model: terminalFontSizePx,
        min: minTerminalFontSizePx,
        max: maxTerminalFontSizePx,
        clamp: clampTerminalFontSize,
      },
    ],
    editorSuboption: false,
  },
  {
    id: 'app',
    labelKey: 'settings.appMonospaceFontFamily.label',
    descriptionKey: 'settings.appMonospaceFontFamily.description',
    family: appMonospaceFontFamily,
    placeholder: defaultAppMonospaceFontFamily,
    presets: appMonospaceFontPresets.value,
    statusEntries: appFontStatusEntries.value,
    presetLabelId: appPresetLabelId,
    inputLabelId: appInputLabelId,
    textareaId: appTextareaId,
    discoveryOpen: isAppFontDiscoveryOpen,
    sizes: [
      {
        inputId: appSizeInputId,
        labelKey: 'settings.appFontSizePx.label',
        descriptionKey: 'settings.appFontSizePx.description',
        model: appFontSizePx,
        min: minAppFontSizePx,
        max: maxAppFontSizePx,
        clamp: clampAppFontSize,
      },
      {
        inputId: messageSizeInputId,
        labelKey: 'settings.messageFontSizePx.label',
        descriptionKey: 'settings.messageFontSizePx.description',
        model: messageFontSizePx,
        min: minMessageFontSizePx,
        max: maxMessageFontSizePx,
        clamp: clampMessageFontSize,
      },
      {
        inputId: sidebarSizeInputId,
        labelKey: 'settings.sidebarFontSizePx.label',
        descriptionKey: 'settings.sidebarFontSizePx.description',
        model: sidebarFontSizePx,
        min: minSidebarFontSizePx,
        max: maxSidebarFontSizePx,
        clamp: clampSidebarFontSize,
      },
      {
        inputId: uiSizeInputId,
        labelKey: 'settings.uiFontSizePx.label',
        descriptionKey: 'settings.uiFontSizePx.description',
        model: uiFontSizePx,
        min: minUiFontSizePx,
        max: maxUiFontSizePx,
        clamp: clampUiFontSize,
      },
    ],
    editorSuboption: true,
  },
]);

function clampTerminalFontSize() {
  terminalFontSizePx.value = Math.max(
    minTerminalFontSizePx,
    Math.min(maxTerminalFontSizePx, terminalFontSizePx.value),
  );
}

function clampAppFontSize() {
  appFontSizePx.value = Math.max(minAppFontSizePx, Math.min(maxAppFontSizePx, appFontSizePx.value));
}

function clampMessageFontSize() {
  messageFontSizePx.value = Math.max(
    minMessageFontSizePx,
    Math.min(maxMessageFontSizePx, messageFontSizePx.value),
  );
}

function clampSidebarFontSize() {
  sidebarFontSizePx.value = Math.max(
    minSidebarFontSizePx,
    Math.min(maxSidebarFontSizePx, sidebarFontSizePx.value),
  );
}

function clampUiFontSize() {
  uiFontSizePx.value = Math.max(minUiFontSizePx, Math.min(maxUiFontSizePx, uiFontSizePx.value));
}

function clampOpenInEditorMaxSizeMb() {
  openInEditorMaxSizeMb.value = Math.max(
    minOpenInEditorMaxSizeMb,
    Math.min(maxOpenInEditorMaxSizeMb, openInEditorMaxSizeMb.value),
  );
}

function clampEditorFontSize() {
  if (editorFontSizePx.value === null) return;
  editorFontSizePx.value = Math.max(
    minEditorFontSizePx,
    Math.min(maxEditorFontSizePx, editorFontSizePx.value),
  );
}

function inheritEditorFontSize() {
  editorFontSizePx.value = null;
}

function clampEditorTabSize() {
  editorTabSize.value = Math.max(minEditorTabSize, Math.min(maxEditorTabSize, editorTabSize.value));
}

function resetEditorShortcuts() {
  recordingShortcut.value = null;
  editorShortcuts.value = { ...defaultEditorShortcuts };
}

const activeTagFilter = ref<string | null>(null);
const editingTextTransformerId = ref<string | null>(null);
const textTransformerVariables = [
  '{cursor}',
  '{date}',
  '{time}',
  '{datetime}',
  '{uuid}',
  '{clipboard}',
  '{activeFile}',
  '{cwd}',
  '{selection}',
] as const;
const textTransformerTagDrafts = ref<Record<string, string>>({});
const textTransformerImportStatus = ref<{ kind: 'success' | 'error'; message: string } | null>(
  null,
);
let textTransformerImportGeneration = 0;

const transformerTagFilters = computed(() => {
  const tags: string[] = [];
  const keys = new Set<string>();
  for (const snippet of textTransformers.value) {
    for (const tag of snippet.tags) {
      const key = tag.toLocaleLowerCase();
      if (keys.has(key)) continue;
      keys.add(key);
      tags.push(tag);
    }
  }
  return tags;
});

function reconcileActiveTagFilter(tags: readonly string[]) {
  const active = activeTagFilter.value;
  if (!active) return;
  const canonical = tags.find((tag) => tag.toLocaleLowerCase() === active.toLocaleLowerCase());
  if (canonical) activeTagFilter.value = canonical;
  else if (!editingTextTransformerId.value) activeTagFilter.value = null;
}

watch(transformerTagFilters, reconcileActiveTagFilter);

const visibleTextTransformers = computed(() => {
  const entries = textTransformers.value.map((snippet, index) => ({ snippet, index }));
  const filter = activeTagFilter.value;
  if (!filter) return entries;
  const lowered = filter.toLocaleLowerCase();
  return entries.filter(({ snippet }) =>
    snippet.tags.some((tag) => tag.toLocaleLowerCase() === lowered),
  );
});

const editingTextTransformerIndex = computed(() =>
  textTransformers.value.findIndex((snippet) => snippet.id === editingTextTransformerId.value),
);
const editingTextTransformer = computed(
  () => textTransformers.value[editingTextTransformerIndex.value] ?? null,
);

const transformerEmptyText = computed(() =>
  textTransformers.value.length === 0
    ? t('settings.textTransformers.empty')
    : t('settings.textTransformers.emptyFiltered'),
);

function toggleTagFilter(tag: string) {
  activeTagFilter.value = activeTagFilter.value === tag ? null : tag;
}

function textTransformerTitle(snippet: TextTransformer) {
  const name = snippet.name.trim();
  if (name) return name;
  const trigger = snippet.trigger.trim();
  if (trigger) return trigger;
  return t('settings.textTransformers.untitled');
}

function textTransformerDisplayTrigger(snippet: TextTransformer) {
  return textTransformerSequence(snippet);
}

function goBackInSettings() {
  if (activePage.value === 'transformers' && editingTextTransformerId.value) {
    editingTextTransformerId.value = null;
    reconcileActiveTagFilter(transformerTagFilters.value);
    return;
  }
  activePage.value = 'root';
}

function textTransformerTagText(snippet: TextTransformer) {
  return textTransformerTagDrafts.value[snippet.id] ?? snippet.tags.join(', ');
}

function parseTextTransformerTags(value: string): string[] {
  const tags: string[] = [];
  const keys = new Set<string>();
  for (const part of value.split(',')) {
    const tag = part.trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || keys.has(key)) continue;
    keys.add(key);
    tags.push(tag);
  }
  return tags;
}

function replaceTextTransformer(id: string, update: (snippet: TextTransformer) => TextTransformer) {
  textTransformers.value = textTransformers.value.map((snippet) =>
    snippet.id === id ? update(snippet) : snippet,
  );
}

function addTextTransformer() {
  const draft: TextTransformer = {
    id: `snippet-${globalThis.crypto.randomUUID()}`,
    trigger: '',
    name: '',
    body: '',
    enabled: true,
    tags: [],
  };
  textTransformers.value = [...textTransformers.value, draft];
  editingTextTransformerId.value = draft.id;
}

function removeTextTransformer(id: string) {
  textTransformers.value = textTransformers.value.filter((snippet) => snippet.id !== id);
  if (editingTextTransformerId.value === id) editingTextTransformerId.value = null;
}

function updateTextTransformerField(
  id: string,
  field: 'trigger' | 'name' | 'description' | 'body',
  event: Event,
) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
  replaceTextTransformer(id, (snippet) => {
    if (field === 'trigger') return { ...snippet, trigger: input.value.replace(/^\\+/u, '') };
    if (field === 'description') {
      return { ...snippet, description: input.value || undefined };
    }
    return { ...snippet, [field]: input.value };
  });
}

function toggleTextTransformerEnabled(id: string) {
  replaceTextTransformer(id, (snippet) =>
    isValidTextTransformerTrigger(snippet.trigger)
      ? { ...snippet, enabled: !snippet.enabled }
      : snippet,
  );
}

function updateTextTransformerTags(id: string, event: Event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  textTransformerTagDrafts.value = { ...textTransformerTagDrafts.value, [id]: input.value };
  const tags = parseTextTransformerTags(input.value);
  replaceTextTransformer(id, (snippet) => ({ ...snippet, tags }));
}

function exportTextTransformers() {
  const parsed = parseTextTransformerImport(
    JSON.stringify({ version: TEXT_TRANSFORMER_EXPORT_VERSION, snippets: textTransformers.value }),
  );
  if (!parsed.ok) {
    textTransformerImportStatus.value = {
      kind: 'error',
      message: t('settings.textTransformers.importErrors.invalidSnippets'),
    };
    return;
  }
  downloadJsonFile(
    { version: TEXT_TRANSFORMER_EXPORT_VERSION, snippets: parsed.snippets },
    'vis-snippets.json',
  );
}

const textTransformerImportErrorKeys = {
  'invalid-json': 'settings.textTransformers.importErrors.invalidJson',
  'unsupported-version': 'settings.textTransformers.importErrors.unsupportedVersion',
  'invalid-snippets': 'settings.textTransformers.importErrors.invalidSnippets',
} as const;

async function parseSelectedTextTransformerFile(
  file: File,
  importGeneration: number,
): Promise<TextTransformerImportResult | null> {
  if (file.size > MAX_TEXT_TRANSFORMER_IMPORT_BYTES) {
    return { ok: false, reason: 'invalid-snippets' };
  }
  const contents = await file.text();
  if (importGeneration !== textTransformerImportGeneration) return null;
  return parseTextTransformerImport(contents);
}

function persistImportedTextTransformers(imported: readonly TextTransformer[]): boolean {
  const merged = mergeTextTransformers(textTransformers.value, imported);
  if (merged.length > MAX_TEXT_TRANSFORMER_IMPORT_COUNT) return false;
  if (!storageSetJSON(StorageKeys.settings.textTransformers, merged)) return false;
  textTransformers.value = merged;
  return true;
}

async function importTextTransformers(event: Event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  if (!file) return;
  const importGeneration = ++textTransformerImportGeneration;
  try {
    const result = await parseSelectedTextTransformerFile(file, importGeneration);
    if (!result) return;
    if (!result.ok) {
      textTransformerImportStatus.value = {
        kind: 'error',
        message: t(textTransformerImportErrorKeys[result.reason]),
      };
      return;
    }
    if (!persistImportedTextTransformers(result.snippets)) {
      textTransformerImportStatus.value = {
        kind: 'error',
        message: t('settings.textTransformers.importErrors.invalidSnippets'),
      };
      return;
    }
    textTransformerTagDrafts.value = {};
    activeTagFilter.value = null;
    textTransformerImportStatus.value = {
      kind: 'success',
      message: t('settings.textTransformers.importSuccess', { count: result.snippets.length }),
    };
  } catch {
    if (importGeneration !== textTransformerImportGeneration) return;
    textTransformerImportStatus.value = {
      kind: 'error',
      message: t('settings.textTransformers.importErrors.invalidJson'),
    };
  } finally {
    input.value = '';
  }
}

function textTransformerTriggerError(index: number) {
  const issue = getTextTransformerTriggerIssue(textTransformers.value, index);
  if (issue === 'invalid') return t('settings.textTransformers.invalidTrigger');
  if (issue === 'duplicate') return t('settings.textTransformers.duplicateTrigger');
  return '';
}

function textTransformerTriggerInputId(index: number) {
  return `settings-text-transformer-trigger-${index}`;
}

function textTransformerTriggerErrorId(index: number) {
  return `settings-text-transformer-trigger-error-${index}`;
}

function beginShortcutRecording(key: EditorShortcutKey) {
  recordingShortcut.value = recordingShortcut.value === key ? null : key;
}

function cancelShortcutRecording(key: EditorShortcutKey) {
  if (recordingShortcut.value === key) recordingShortcut.value = null;
}

function recordShortcut(key: EditorShortcutKey, event: KeyboardEvent) {
  if (recordingShortcut.value !== key) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') {
    recordingShortcut.value = null;
    return;
  }
  if (
    event.key === 'Backspace' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    editorShortcuts.value = { ...editorShortcuts.value, [key]: '' };
    recordingShortcut.value = null;
    return;
  }
  const shortcut = shortcutFromKeyboardEvent(event);
  if (!shortcut) return;
  editorShortcuts.value = { ...editorShortcuts.value, [key]: shortcut };
  recordingShortcut.value = null;
}

function shortcutButtonLabel(key: EditorShortcutKey) {
  if (recordingShortcut.value === key) return t('settings.editor.shortcuts.recording');
  const shortcut = editorShortcuts.value[key];
  return shortcut ? formatShortcutForDisplay(shortcut) : t('settings.editor.shortcuts.unassigned');
}

async function browseLocalApplication() {
  localApplicationError.value = '';
  try {
    const selectedPath = await window.electronAPI?.localFile?.selectApplication();
    if (selectedPath) localApplicationPath.value = selectedPath;
  } catch (error) {
    localApplicationError.value = error instanceof Error ? error.message : String(error);
  }
}

async function clearLocalApplication() {
  localApplicationError.value = '';
  try {
    await window.electronAPI?.localFile?.clearApplication();
    localApplicationPath.value = '';
  } catch (error) {
    localApplicationError.value = error instanceof Error ? error.message : String(error);
  }
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

const pageTitle = computed(() => {
  switch (activePage.value) {
    case 'root':
      return t('settings.title');
    case 'fonts':
      return t('settings.fontsPageTitle');
    case 'editor':
      return t('settings.editor.pageTitle');
    case 'transformers':
      return editingTextTransformer.value
        ? textTransformerTitle(editingTextTransformer.value)
        : t('settings.textTransformers.pageTitle');
    case 'theme':
      return t('settings.themePageTitle');
    case 'experimental':
      return t('settings.experimentalFeatures.pageTitle');
    default:
      return t('settings.title');
  }
});

watch(
  () => props.open,
  (open) => {
    const el = dialogRef.value;
    if (!el) return;
    if (open) {
      activePage.value = props.initialPage ?? 'root';
      editingTextTransformerId.value = null;
      activeTagFilter.value = null;
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

.editor-number-control {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.editor-number-control .number-input {
  min-width: 0;
}

.editor-shortcut-heading,
.local-application-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.transformer-settings-section {
  --transformer-toolbar-button-height: 34px;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}

.transformer-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  align-self: stretch;
  width: 100%;
}

.transformer-add {
  flex: 0 0 auto;
  height: var(--transformer-toolbar-button-height);
  border-color: color-mix(in srgb, var(--theme-accent-primary, #60a5fa) 55%, transparent);
  background: color-mix(in srgb, var(--theme-accent-primary, #60a5fa) 18%, transparent);
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  white-space: nowrap;
}

.transformer-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.transformer-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.transformer-tag-filters {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.transformer-tag-filter {
  height: var(--ui-chip-height);
  border: 1px solid
    var(--theme-modal-border, var(--theme-border-muted, rgba(148, 163, 184, 0.65)));
  border-radius: var(--ui-chip-radius);
  background: var(--theme-modal-control-bg, var(--theme-surface-chip, rgba(15, 23, 42, 0.75)));
  color: var(--theme-modal-text, var(--theme-text-primary, #bfdbfe));
  font-family: var(--ui-chip-font-family);
  font-size: var(--ui-chip-font-size);
  font-weight: 600;
  letter-spacing: var(--ui-chip-letter-spacing);
  padding: 0 var(--ui-chip-padding-x);
  white-space: nowrap;
  cursor: pointer;
}

.transformer-tag-filter:hover {
  background: var(--theme-modal-active-bg, var(--theme-surface-chip-hover, rgba(30, 41, 59, 0.92)));
}

.transformer-tag-filter.is-active,
.font-preset-chip.is-active {
  border-color: var(--theme-modal-accent, var(--theme-border-accent, rgba(59, 130, 246, 0.45)));
  background: var(
    --theme-modal-active-bg,
    var(--theme-surface-panel-active, rgba(59, 130, 246, 0.2))
  );
  color: var(--theme-modal-active-text, var(--theme-text-primary, #dbeafe));
}

.transformer-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.transformer-actions .font-system-button {
  height: var(--transformer-toolbar-button-height);
  min-height: var(--transformer-toolbar-button-height);
  white-space: nowrap;
}

.transformer-import-button {
  position: relative;
  overflow: hidden;
}

.transformer-import-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.transformer-import-status {
  min-height: 14px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: 11px;
}

.transformer-import-status.is-success {
  color: var(--theme-status-success, #4ade80);
}

.transformer-import-status.is-error {
  color: var(--theme-status-error, #f87171);
}

.transformer-import-status:empty {
  display: none;
}

.transformer-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--ui-form-control-border);
  border-radius: 8px;
  background: var(--theme-modal-control-bg, var(--theme-surface-panel-muted, rgba(2, 6, 23, 0.3)));
}

.transformer-row.is-disabled :deep(.snippet-completion) {
  opacity: 0.58;
}

.transformer-row-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.transformer-action-button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--theme-top-dropdown-border, #334155);
  border-radius: 8px;
  background: var(--theme-top-dropdown-control-bg, #0b1320);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  line-height: 1;
  cursor: pointer;
}

.transformer-action-button:hover {
  background: var(--theme-top-dropdown-active-bg, #1d2a45);
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.transformer-enable.is-active {
  color: var(--theme-status-success, #4ade80);
}

.transformer-remove {
  color: var(--theme-text-danger, #fca5a5);
}

.transformer-edit {
  color: var(--theme-status-git-archived, #c4b5fd);
}

.transformer-detail {
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}

.transformer-detail-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.transformer-detail-status {
  flex: 1 1 auto;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: 11px;
}

.transformer-row-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  width: 100%;
}

.transformer-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.transformer-field-body {
  grid-column: 1 / -1;
}

.transformer-field-label {
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
  font-size: 10px;
  font-weight: 600;
}

.transformer-input {
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--ui-form-control-border);
  border-radius: 6px;
  background: var(--ui-form-control-bg);
  color: var(--ui-form-control-text);
  font: inherit;
  font-size: 12px;
}

.transformer-body {
  height: auto;
  min-height: 72px;
  padding: 8px;
  line-height: 1.5;
  resize: vertical;
}

.transformer-variable-help {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin-top: 4px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: 11px;
}

.transformer-variable-help code {
  color: var(--theme-modal-text, var(--theme-text-secondary, #cbd5e1));
  font-size: 11px;
}

.transformer-input:focus {
  position: relative;
  outline: none;
  border-color: var(--ui-form-control-focus-border);
  box-shadow: var(--ui-form-control-focus-ring);
}

.transformer-empty,
.transformer-error {
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #64748b));
  font-size: 11px;
}

.transformer-empty {
  width: 100%;
  padding: 12px;
  border: 1px dashed var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 8px;
  text-align: center;
}

.transformer-error {
  color: var(--theme-status-error, #f87171);
  font-size: 10px;
}

.editor-shortcut-heading {
  width: 100%;
}

.editor-shortcut-section {
  flex-direction: column;
}

.editor-shortcut-description {
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.editor-shortcut-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 12px;
  width: 100%;
}

.editor-shortcut-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px 4px;
  min-width: 0;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  font-size: 11px;
}

.editor-shortcut-label {
  line-height: 1.25;
}

.editor-shortcut-recorder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 140px;
  max-width: 100%;
  min-height: 30px;
  padding: 5px 8px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 6px;
  background: var(--theme-modal-control-bg, var(--theme-surface-panel, #0f172a));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  cursor: pointer;
  font-family: var(--app-monospace-font-family, ui-monospace, monospace);
  font-size: 10.5px;
}

.editor-shortcut-recorder:hover,
.editor-shortcut-recorder:focus-visible,
.editor-shortcut-recorder.is-recording {
  border-color: var(--theme-accent, var(--theme-text-accent, #60a5fa));
  outline: none;
}

.editor-shortcut-recorder.is-recording {
  background: color-mix(in srgb, var(--theme-accent, #60a5fa) 12%, transparent);
}

.editor-shortcut-recorder.is-invalid {
  border-color: var(--theme-status-error, #f87171);
}

.editor-shortcut-recorder kbd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.local-application-controls .font-stack-input {
  min-width: 0;
  width: 100%;
}

.local-application-controls .font-system-button {
  flex: 0 0 auto;
  white-space: nowrap;
}

.editor-shortcut-error {
  grid-column: 1 / -1;
  color: var(--theme-status-error, #f87171);
  font-size: 10px;
}

@media (max-width: 760px) {
  .editor-shortcut-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 520px) {
  .editor-shortcut-grid {
    grid-template-columns: 1fr;
  }

  .local-application-controls {
    align-items: stretch;
    flex-direction: column;
  }

  .transformer-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .transformer-actions {
    margin-left: 0;
  }

  .transformer-row-grid {
    grid-template-columns: 1fr;
  }
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
  background: var(
    --theme-modal-active-bg,
    var(--theme-surface-panel-hover, rgba(15, 23, 42, 0.72))
  );
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
  background: var(
    --theme-modal-active-bg,
    var(--theme-surface-panel-hover, rgba(15, 23, 42, 0.72))
  );
}

.theme-preset-card.is-active {
  border-color: var(--theme-modal-accent, var(--theme-border-accent, rgba(59, 130, 246, 0.45)));
  background: var(
    --theme-modal-active-bg,
    var(--theme-surface-panel-active, rgba(59, 130, 246, 0.16))
  );
  box-shadow: 0 0 0 1px
    color-mix(
      in srgb,
      var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6)) 35%,
      transparent
    );
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
  border-top: 1px solid
    var(--theme-modal-border, var(--theme-border-default, rgba(51, 65, 85, 0.4)));
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

.font-setting-suboption {
  margin-left: 10px;
  padding-left: 10px;
  border-left: 1px solid
    var(--theme-modal-border, var(--theme-border-muted, rgba(148, 163, 184, 0.35)));
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
  --ui-chip-border-neutral: var(
    --theme-modal-border,
    var(--theme-border-muted, rgba(148, 163, 184, 0.65))
  );
  --ui-chip-bg-neutral: var(
    --theme-modal-control-bg,
    var(--theme-surface-chip, rgba(15, 23, 42, 0.75))
  );
  --ui-chip-bg-hover: var(
    --theme-modal-active-bg,
    var(--theme-surface-chip-hover, rgba(30, 41, 59, 0.92))
  );
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
  white-space: nowrap;
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
  background: var(
    --theme-modal-control-bg,
    var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72))
  );
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  text-align: left;
  cursor: pointer;
}

.font-system-item:hover {
  border-color: var(--theme-modal-accent, var(--theme-border-strong, #475569));
  background: var(
    --theme-modal-active-bg,
    var(--theme-surface-panel-hover, rgba(30, 41, 59, 0.92))
  );
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
  box-shadow: 0 0 0 1px
    color-mix(
      in srgb,
      var(--theme-modal-accent, var(--theme-accent-primary, #3b82f6)) 55%,
      transparent
    );
}
</style>
