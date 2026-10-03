import { expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { BackendKind } from '../backends/types';
import { useBackendMessageSend } from './useBackendMessageSend';
import { createDshSlashDispatcher } from './backendMessageSend.dshSlash';
import { createBaseParams, createCodexApi, createOpenCodeApi, deferred, imageAttachment } from './useBackendMessageSend.test-helpers';
function fixture() {
  return { ...createBaseParams(), activeBackendKind: ref<BackendKind>('dsh'), codexApi: createCodexApi(), openCodeApi: createOpenCodeApi() };
}
it('downloads /export before model send gates and preserves attachments', async () => {
  const params = fixture(); params.messageInput.value = '/export'; params.canSend.value = false; params.attachments.value = [imageAttachment()];
  const onDshExportSession = vi.fn(async () => undefined);
  await useBackendMessageSend({ ...params, onDshExportSession }).sendMessage();
  expect(onDshExportSession).toHaveBeenCalledWith('session-1', expect.any(AbortSignal));
  expect(params.messageInput.value).toBe('');
  expect(params.attachments.value).toHaveLength(1);
  expect(params.persistComposerDraftForCurrentContext).toHaveBeenCalledOnce();
  expect(params.codexApi.sendPrompt).not.toHaveBeenCalled();
});
it('opens bare feedback as a dialog without sending it as a model prompt', async () => {
  const params = fixture(); params.messageInput.value = '/feedback';
  const onDshFeedback = vi.fn();
  await useBackendMessageSend({ ...params, onDshFeedback }).sendMessage();
  expect(onDshFeedback).toHaveBeenCalledWith('session-1');
  expect(params.messageInput.value).toBe('');
  expect(params.recentUserInputs).toHaveLength(0);
});
it('leaves textual feedback and export arguments for native command validation', async () => {
  const params = fixture(); const onDshFeedback = vi.fn();
  const dispatch = createDshSlashDispatcher({ ...params, onDshFeedback });
  params.messageInput.value = '/feedback preserve this text'; expect(await dispatch()).toBe(false);
  params.messageInput.value = '/export /tmp/path'; expect(await dispatch()).toBe(false);
  expect(onDshFeedback).not.toHaveBeenCalled();
});
it('retains the command on export failure and does not overwrite a replacement draft', async () => {
  const params = fixture(); params.messageInput.value = '/export';
  const pending = deferred<void>();
  const dispatch = createDshSlashDispatcher({ ...params, onDshExportSession: () => pending.promise });
  const work = dispatch(); params.messageInput.value = 'replacement draft'; pending.reject(new Error('Export failed')); await work;
  expect(params.messageInput.value).toBe('replacement draft');
  expect(params.setSendStatusKey).toHaveBeenCalledWith('app.error.sendFailed', { message: 'Error: Export failed' });
  params.messageInput.value = '/export';
  await createDshSlashDispatcher({ ...params, onDshExportSession: async () => { throw new Error('Failed'); } })();
  expect(params.messageInput.value).toBe('/export');
});
it('aborts a stale session export and preserves the new session draft', async () => {
  const params = fixture(); params.messageInput.value = '/export'; const pending = deferred<void>();
  let signal: AbortSignal | undefined;
  const dispatch = createDshSlashDispatcher({ ...params, onDshExportSession: (_id, value) => { signal = value; return pending.promise; } });
  const work = dispatch(); params.selectedSessionId.value = 'session-2'; params.messageInput.value = 'new session draft';
  expect(signal?.aborted).toBe(true); pending.resolve(); await work;
  expect(params.messageInput.value).toBe('new session draft');
  expect(params.setSendStatusKey).not.toHaveBeenCalled();
});
it('rejects missing session or missing callback without clearing the command', async () => {
  const params = fixture(); params.messageInput.value = '/feedback'; params.selectedSessionId.value = '';
  expect(await createDshSlashDispatcher(params)()).toBe(true);
  expect(params.setSendStatusKey).toHaveBeenLastCalledWith('app.error.noSessionSelected');
  params.selectedSessionId.value = 's1'; await createDshSlashDispatcher(params)();
  expect(params.setSendStatusKey).toHaveBeenLastCalledWith('app.error.unavailable', { action: '/feedback' });
  expect(params.messageInput.value).toBe('/feedback');
});
it('coalesces duplicate export activation until its download completes', async () => {
  const params = fixture(); params.messageInput.value = '/export'; const pending = deferred<void>();
  const onDshExportSession = vi.fn(() => pending.promise); const dispatch = createDshSlashDispatcher({ ...params, onDshExportSession });
  const work = dispatch(); await dispatch(); expect(onDshExportSession).toHaveBeenCalledOnce(); pending.resolve(); await work;
});
