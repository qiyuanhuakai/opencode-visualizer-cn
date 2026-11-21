<template>
  <section class="runtime-pins" data-runtime-ui data-testid="runtime-pins" :aria-label="rt('Pinned sessions')">
    <ul v-if="containers?.length">
      <li v-for="container in containers" :key="container.key">
        <button type="button" class="action-button pin-session pin-container" @click="emit('select-container', container.key)">
          <Icon :icon="container.kind === 'project' ? 'lucide:package' : 'lucide:git-branch'" :width="14" :height="14" aria-hidden="true" />
          {{ container.label }}
        </button>
        <button type="button" class="action-button unpin-session" :aria-label="`${$t('topPanel.sessionActions.unpin')} ${container.label}`" @click="emit('unpin-container', container.key)">
          <Icon icon="lucide:pin-off" :width="14" :height="14" aria-hidden="true" />
        </button>
      </li>
    </ul>
    <p v-if="pins.error.value" role="alert">{{ rt(pins.error.value) }}</p>
    <p v-if="pins.busy.value" role="status">{{ rt('Loading pinned sessions') }}</p>
    <ul v-else>
      <li v-for="record in pins.records.value" :key="encodeSessionKey(record.selection.session)">
        <button type="button" class="action-button pin-session" :title="`${record.selection.session.environmentId}\n${record.selection.session.harnessInstanceId}\n${record.selection.session.nativeSessionId}`" @click="emit('select', record.selection)">{{ pins.title(record.selection) }}</button>
        <button
          type="button"
          class="action-button unpin-session"
          :title="$t('topPanel.sessionActions.unpin')"
          :aria-label="`${$t('topPanel.sessionActions.unpin')} ${pins.title(record.selection)}`"
          @click="pins.setPinned([record.selection], false)"
        >
          <Icon icon="lucide:pin-off" :width="14" :height="14" aria-hidden="true" />
        </button>
      </li>
    </ul>
    <p v-if="!pins.busy.value && pins.records.value.length === 0 && !containers?.length">{{ rt('No pinned sessions on this page') }}</p>
    <div v-if="pins.hasNext.value || pins.hasPrevious.value" class="pin-actions">
      <button type="button" class="action-button" :disabled="pins.busy.value || !pins.hasPrevious.value" @click="pins.firstPage()">{{ rt('First pin page') }}</button>
      <button type="button" class="action-button" :disabled="pins.busy.value || !pins.hasNext.value" @click="pins.nextPage()">{{ rt('Next pin page') }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { encodeSessionKey } from '../../../shared/runtime/identity.js';
import type { QualifiedSession } from '../../runtime/selectionScope';
import type { RuntimePinsState } from '../../composables/useRuntimePins';
import { useRuntimeUi } from '../../locales/runtimeUi';
import type { RuntimeContainerPin } from '../../types/top-panel';
defineProps<{ pins: RuntimePinsState; containers?: readonly RuntimeContainerPin[] }>();
const emit = defineEmits<{
  (event: 'select', selection: QualifiedSession): void;
  (event: 'select-container' | 'unpin-container', key: string): void;
}>();
const { rt } = useRuntimeUi();
</script>

<style scoped>
.runtime-pins { min-width: 0; padding: 6px; border-top: 1px solid var(--theme-border-subtle); color: var(--theme-text-primary); }
.pin-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.action-button { padding: 3px 7px; border: 1px solid var(--ui-form-button-border); border-radius: var(--radius-control); font-family: inherit; cursor: pointer; }
.action-button:disabled { opacity: .5; cursor: not-allowed; }
.runtime-pins ul { max-height: 180px; overflow: auto; list-style: none; margin: 4px 0; padding: 0; }
.runtime-pins li { display: flex; min-width: 0; gap: 4px; }
.pin-container :deep(svg) { display: inline-block; margin-inline-end: 4px; vertical-align: middle; }
.unpin-session { flex-shrink: 0; }
.pin-session { display: block; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: start; }
.runtime-pins p { margin: 4px 0; font-size: var(--type-caption); }
</style>
