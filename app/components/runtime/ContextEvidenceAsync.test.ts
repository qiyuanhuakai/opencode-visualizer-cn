import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, shallowRef } from 'vue';
import { createI18n } from 'vue-i18n';
import { buildContextCheckpoint, registerEvidence } from '../../../shared/runtime/context.js';
import type { EvidencePageView, EvidenceTarget } from '../../../shared/runtime/context.js';
import type { AsyncEvidencePageReader } from '../../runtime/hostEvidenceViews';
import ContextEvidenceView from './ContextEvidenceView.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const target = { repoKey: 'actual-repository', revision: 'base-one' };
const record = registerEvidence({ bytes: 'evidence page', origin: { kind: 'file', path: 'proof.txt' }, target });
const checkpoint = buildContextCheckpoint({ checkpointId: '11111111-1111-4111-8111-111111111111', scope: { threadId: '22222222-2222-4222-8222-222222222222', environmentId: '33333333-3333-4333-8333-333333333333' }, entries: [{ class: 'artifact', origin: record.origin, evidence: { hash: record.hash, bytes: record.bytes, target } }] });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

describe('asynchronous Bridge evidence pages', () => {
  it('keeps a pending page through a Host refresh with the same checkpoint digest and target', async () => {
    let release: (value: EvidencePageView) => void = () => {};
    const pending = new Promise<EvidencePageView>((resolve) => { release = resolve; });
    const read: AsyncEvidencePageReader = () => pending;
    const context = shallowRef(checkpoint);
    const currentTarget = shallowRef(target);
    const root = document.createElement('div'); document.body.appendChild(root);
    const app = createApp({ render: () => h(ContextEvidenceView, { checkpoint: context.value, currentTarget: currentTarget.value, readEvidencePage: read }) });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
    app.mount(root); await nextTick(); cleanups.push(() => { app.unmount(); root.remove(); });
    const button = root.querySelector('[data-testid="read-evidence-page"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('Missing evidence reader');
    button.click(); await nextTick();
    context.value = { ...checkpoint }; currentTarget.value = { ...target }; await nextTick();
    release({ available: true, hash: record.hash, offset: 0, length: record.bytes, totalBytes: record.bytes, bytes: new TextEncoder().encode('evidence page'), nextOffset: null, target });
    await pending; await nextTick();
    expect(root.querySelector('[data-testid="evidence-page-text"]')?.textContent).toBe('evidence page');
  });

  it('captures a user-selected path and removes only its handoff selection', async () => {
    const capture = vi.fn(async () => record);
    const remove = vi.fn();
    const root = document.createElement('div'); document.body.appendChild(root);
    const app = createApp({ render: () => h(ContextEvidenceView, { checkpoint: null, captureEvidence: capture, capturedEvidence: [record], removeEvidence: remove }) });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
    app.mount(root); await nextTick();
    cleanups.push(() => { app.unmount(); root.remove(); });
    const path = root.querySelector('.capture-path');
    if (!(path instanceof HTMLInputElement)) throw new Error('Missing evidence path');
    path.value = ' proof.txt '; path.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await nextTick(); await nextTick();
    expect(capture).toHaveBeenCalledWith({ kind: 'file', path: 'proof.txt' });
    expect(path.value).toBe('');
    const removeButton = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Remove from handoff');
    if (!removeButton) throw new Error('Missing evidence selection removal');
    removeButton.click();
    expect(remove).toHaveBeenCalledWith(record.hash);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('discards a byte page that resolves after the evidence target changes', async () => {
    let release: (value: EvidencePageView) => void = () => {};
    const pending = new Promise<EvidencePageView>((resolve) => { release = resolve; });
    const read: AsyncEvidencePageReader = () => pending;
    const currentTarget = shallowRef<EvidenceTarget>(target);
    const root = document.createElement('div'); document.body.appendChild(root);
    const app = createApp({ render: () => h(ContextEvidenceView, { checkpoint, currentTarget: currentTarget.value, readEvidencePage: read }) });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
    app.mount(root); await nextTick();
    cleanups.push(() => { app.unmount(); root.remove(); });
    const button = root.querySelector('[data-testid="read-evidence-page"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('Missing evidence page action');
    expect(button.disabled).toBe(false); button.click(); await nextTick();
    expect(button.disabled).toBe(true);
    currentTarget.value = { ...target, revision: 'base-two' }; await nextTick(); await nextTick();
    release({ available: true, hash: record.hash, offset: 0, length: record.bytes, totalBytes: record.bytes, bytes: new TextEncoder().encode('evidence page'), nextOffset: null, target });
    await pending; await nextTick();
    expect(root.querySelector('[data-testid="evidence-page-text"]')).toBeNull();
    expect(root.querySelector('[data-testid="evidence-error"]')).toBeNull();
    expect(button.disabled).toBe(false);
  });
});
