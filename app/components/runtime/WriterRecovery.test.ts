import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { parseSessionRef } from '../../../shared/runtime/identity.js';
import type { CollaborationTaskView, CollaborationWriterView } from '../../composables/useRuntimeCollaboration';
import ArtifactReview from './ArtifactReview.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

describe('writer recovery controls', () => {
  it('separates verification, explicit missing-worktree creation and existing-session reconnect', async () => {
    const task: CollaborationTaskView = {
      taskId: 'task', title: 'Recover writer', state: 'pending', phase: 'pending', depth: 0,
      review: { state: 'none', reviewer: null, reason: null },
      acceptance: { state: 'none', acceptedBy: null, deliverableId: null, criteria: [] },
      deliverables: [], attempts: [], criteria: [], dependsOn: [], children: [], blockedBy: [], ambiguous: false, pausedReasons: [],
      owner: { participantId: 'participant', session: parseSessionRef({ environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: 'native' }) },
    };
    const writer = ref<CollaborationWriterView>({ leaseId: 'lease', state: 'reconciling', binding: { phase: 'reconciling', lastError: 'source_unavailable' }, worktree: '/writers/lease', nativeCwd: '/writers/lease', baseCommit: 'a'.repeat(40), policy: { worktreeAccess: 'read-write', userRepository: 'read-only' }, posture: {} });
    const actions: unknown[] = [];
    const root = document.createElement('div'); document.body.appendChild(root);
    const app = createApp({ render: () => h(ArtifactReview, { task, writer: writer.value, onWriterRecovery: (input: unknown) => actions.push(input) }) });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
    app.mount(root); await nextTick();
    cleanups.push(() => { app.unmount(); root.remove(); });
    function button(label: string): HTMLButtonElement {
      const result = Array.from(root.querySelectorAll('button')).find((entry) => entry.textContent === label);
      if (!result) throw new Error(`Missing ${label}`);
      return result;
    }
    expect(root.querySelector('[data-testid="writer-binding"]')?.textContent).toContain('source_unavailable');
    button('Verify and recover worktree').click();
    expect(actions).toEqual([{ leaseId: 'lease', action: 'reconcile' }]);
    expect(button('Create missing worktree').disabled).toBe(true);
    const confirm = root.querySelector('input[type="checkbox"]');
    if (!(confirm instanceof HTMLInputElement)) throw new Error('Missing recovery confirmation');
    confirm.click(); await nextTick(); button('Create missing worktree').click();
    button('Reconnect existing Agent session').click();
    expect(actions.slice(1)).toEqual([{ leaseId: 'lease', action: 'create-missing' }, { leaseId: 'lease', action: 'reconnect' }]);
    writer.value = { ...writer.value, leaseId: 'another-lease' }; await nextTick(); await nextTick();
    expect(button('Create missing worktree').disabled).toBe(true);
  });
});
