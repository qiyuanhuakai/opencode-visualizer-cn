import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, shallowRef } from 'vue';
import { createI18n } from 'vue-i18n';
import { parseSessionRef } from '../../../shared/runtime/identity.js';
import type { CollaborationTaskView } from '../../composables/useRuntimeCollaboration';
import type { ArtifactAction, ArtifactWorkflowView } from '../../runtime/hostArtifactViews';
import ArtifactIntegration from './ArtifactIntegration.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const hash = 'a'.repeat(64);
const task: CollaborationTaskView = {
  taskId: 'task-one', title: 'Review change', state: 'review', phase: 'review-pending', depth: 0,
  review: { state: 'pending', reviewer: 'human', reason: null },
  acceptance: { state: 'none', acceptedBy: null, deliverableId: null, criteria: [] },
  deliverables: [{ deliverableId: 'artifact-one', artifactHash: hash, bytes: 128, paths: ['result.txt'] }],
  attempts: [], owner: { participantId: 'participant-one', session: parseSessionRef({ environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: 'native' }) },
  criteria: [{ id: 'criterion-one', text: 'Verify the actual result', required: true }], dependsOn: [], children: [], blockedBy: [], ambiguous: false, pausedReasons: [],
};
function workflow(approved = false): ArtifactWorkflowView {
  return {
    artifactHash: hash,
    review: { reviewId: 'review-one', artifactHash: hash, repository: '/repo', target: 'main', base: 'b'.repeat(40), state: approved ? 'approved' : 'pending', taskId: task.taskId },
    approvalId: approved ? 'approval-one' : null, integration: null,
    entries: [{ path: 'result.txt', kind: 'file' }], content: null, entryPage: { offset: 0, nextCursor: null, total: 1 },
  };
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function mount(view: ArtifactWorkflowView) {
  const actions: ArtifactAction[] = [];
  const root = document.createElement('div'); document.body.appendChild(root);
  const selectedTask = shallowRef(task);
  const app = createApp({ render: () => h(ArtifactIntegration, { task: selectedTask.value, workflow: view, onAction: (action: ArtifactAction) => actions.push(action) }) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(root); await nextTick();
  cleanups.push(() => { app.unmount(); root.remove(); });
  return { root, actions, selectedTask };
}
function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe('explicit artifact integration controls', () => {
  it('requires approval before requesting a repository integration preview', async () => {
    const { root, actions, selectedTask } = await mount(workflow());
    const prepare = button(root, 'Prepare integration review');
    const form = prepare.closest('form');
    if (!form) throw new Error('Missing integration preview form');
    const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const fields = Array.from(form.querySelectorAll('input'));
    for (const [index, value] of ['/repo', 'main'].entries()) {
      const field = fields[index];
      if (!field) throw new Error('Missing integration preview input');
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await nextTick();
    expect(root.textContent).toContain('Approve the current artifact review first.');
    expect(prepare.disabled).toBe(true);
    submit();
    expect(actions.some(action => action.type === 'prepare')).toBe(false);
    selectedTask.value = { ...task, review: { ...task.review, state: 'approved' } };
    await nextTick();
    expect(prepare.disabled).toBe(false);
    submit();
    expect(actions.find(action => action.type === 'prepare')).toMatchObject({
      type: 'prepare', taskId: task.taskId, artifactHash: hash, repository: '/repo', target: 'main',
    });
  });

  it('requires human confirmation and never turns review approval into integration', async () => {
    const { root, actions } = await mount(workflow());
    const approve = button(root, 'Approve captured change');
    expect(approve.disabled).toBe(true);
    const confirm = root.querySelector('input[type="checkbox"]');
    if (!(confirm instanceof HTMLInputElement)) throw new Error('Missing review confirmation');
    confirm.click(); await nextTick(); approve.click();
    expect(actions.filter((action) => action.type === 'approve')).toEqual([{ type: 'approve', reviewId: 'review-one' }]);
    expect(actions.some((action) => action.type === 'integrate')).toBe(false);
  });

  it('requires every criterion command and preserves argument boundaries without a shell', async () => {
    const { root, actions } = await mount(workflow(true));
    const integrate = button(root, 'Run tests and integrate');
    expect(integrate.disabled).toBe(true);
    const command = root.querySelector('fieldset input');
    const args = root.querySelector('fieldset textarea');
    if (!(command instanceof HTMLInputElement) || !(args instanceof HTMLTextAreaElement)) throw new Error('Missing criterion command inputs');
    command.value = 'node'; command.dispatchEvent(new Event('input', { bubbles: true }));
    args.value = '-e\nconsole.log("a b")'; args.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick(); expect(integrate.disabled).toBe(false);
    const form = integrate.closest('form'); if (!form) throw new Error('Missing integration form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(actions.find((action) => action.type === 'integrate')).toEqual({
      type: 'integrate', approvalId: 'approval-one', tests: [{ criterionId: 'criterion-one', command: 'node', args: ['-e', 'console.log("a b")'] }],
    });
  });

  it('renders captured file content as text and ignores another artifact’s approval', async () => {
    const view = workflow(true);
    const { root } = await mount({ ...view, content: { path: 'result.txt', text: '<img src=x onerror=alert(1)>', binary: false, offset: 0, nextOffset: null, totalBytes: 28 } });
    expect(root.querySelector('pre')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(root.querySelector('img')).toBeNull();
    const mismatch = await mount({ ...view, artifactHash: 'c'.repeat(64) });
    expect(mismatch.root.querySelector('[data-testid="integrate-reviewed-artifact"]')).toBeNull();
  });
});
