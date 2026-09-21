import { watch } from 'vue';
import { createBackendRequestFence } from '../utils/backendRequestFence';
import {
  runKimiWebSend,
  type KimiWebSendExecutionResult,
} from '../backends/kimiWeb/backendMessageSend.kimiWeb';
import { runCodexSend, type CodexExecutionResult } from './backendMessageSend.codex';
import { runOpenCodeSend, type OpenCodeExecutionResult } from './backendMessageSend.openCode';
import { prepareSendPreflight } from './backendMessageSend.preflight';
import { runLocalSlashCommand } from './backendMessageSend.local';
import { createCodexSlashDispatcher } from './backendMessageSend.slash';
import { parseLeadingSlashCommand } from '../utils/codexSlashCommands';
import type {
  BackendMessageSendParams,
  RequestGuard,
  SendPreflight,
} from './backendMessageSend.types';

function assertNever(value: never): never {
  throw new Error(`Unhandled send status: ${String(value)}`);
}

export function useBackendMessageSend(params: BackendMessageSendParams) {
  const dispatchCodexSlash = createCodexSlashDispatcher(params);
  const requestFence = createBackendRequestFence(() => params.activeBackendKind.value);
  let sendingOwner: object | null = null;
  watch(params.activeBackendKind, () => requestFence.invalidate(), { flush: 'sync' });

  function beginSend(text: string, owner: object) {
    if (text) {
      params.recentUserInputs.push({ text, time: Date.now() });
      while (params.recentUserInputs.length > 20) params.recentUserInputs.shift();
    }
    params.messageInput.value = '';
    params.enableFollow();
    sendingOwner = owner;
    params.isSending.value = true;
    params.setSendStatusKey('app.status.sending');
  }

  function commitCodexResult(
    params: BackendMessageSendParams,
    result: CodexExecutionResult,
    guard: RequestGuard,
  ) {
    if (!guard.isCurrent() || result.kind === 'stale') return;
    if (result.kind === 'unsupported-attachment') {
      params.setSendStatusKey('app.error.unsupportedAttachment');
      return;
    }
    if (result.activeThreadId) {
      if (result.startNewThread) params.codexPendingSessionLock.value = result.activeThreadId;
      params.selectedSessionId.value = result.activeThreadId;
    }
    params.attachments.value = [];
    params.clearComposerDraftForCurrentContext();
    params.setSendStatusKey('app.status.sent');
  }

  function commitOpenCodeResult(
    params: BackendMessageSendParams,
    result: OpenCodeExecutionResult,
    guard: RequestGuard,
  ) {
    if (!guard.isCurrent() || result.kind === 'stale' || result.kind === 'no-directory') return;
    params.setSendStatusKey('app.status.sent');
    if (result.kind === 'prompt' || result.kind === 'command') params.attachments.value = [];
    params.clearComposerDraftForCurrentContext();
  }

  function commitKimiWebResult(
    params: BackendMessageSendParams,
    result: KimiWebSendExecutionResult,
    guard: RequestGuard,
  ) {
    if (!guard.isCurrent() || result.kind === 'stale') return;
    // Only `running` is a confirmed send; queued stays pending and blocked is
    // surfaced as a refusal so the composer never reports a false success.
    switch (result.status) {
      case 'running':
        params.setSendStatusKey('app.status.sent');
        break;
      case 'queued':
        params.setSendStatusKey('app.status.sending');
        break;
      case 'blocked':
        params.setSendStatusKey('app.error.actionDisabled', {
          action: params.translate('app.actions.sending'),
        });
        break;
      default:
        return assertNever(result.status);
    }
    params.attachments.value = [];
    params.clearComposerDraftForCurrentContext();
  }

  async function runTransaction(
    params: BackendMessageSendParams,
    preflight: SendPreflight,
    guard: RequestGuard,
  ) {
    const localResult = await runLocalSlashCommand(
      params,
      preflight.slash,
      preflight.transformText,
      guard,
    );
    if (localResult !== 'not-handled') return;
    if (preflight.backend === 'codex') {
      const result = await runCodexSend(params, preflight, guard, (providerConfig) => {
        if (guard.isCurrent()) params.providerConfig.value = providerConfig;
      });
      commitCodexResult(params, result, guard);
      return;
    }
    if (preflight.backend === 'kimi-web') {
      const kimiWebApi = params.kimiWebApi;
      if (!kimiWebApi) {
        params.setSendStatusKey('app.error.unavailable', { action: 'Kimi Web' });
        return;
      }
      const result = await runKimiWebSend(params, preflight, guard, kimiWebApi);
      commitKimiWebResult(params, result, guard);
      return;
    }
    const result = await runOpenCodeSend(params, preflight, guard);
    commitOpenCodeResult(params, result, guard);
  }

  async function sendMessage() {
    if (
      params.activeBackendKind.value === 'codex' &&
      parseLeadingSlashCommand(params.messageInput.value) &&
      (await dispatchCodexSlash())
    )
      return;
    if (!params.ensureConnectionReady(params.translate('app.actions.sending'))) return;
    if (!params.canSend.value) return;
    const preflight = prepareSendPreflight(params);
    if (!preflight || preflight.backend !== params.activeBackendKind.value) return;
    const token = requestFence.start();
    const guard = { isCurrent: () => requestFence.isCurrent(token) } satisfies RequestGuard;
    if (!guard.isCurrent()) return;
    const owner = {};
    beginSend(preflight.hasText ? preflight.transformedText : '', owner);
    try {
      await runTransaction(params, preflight, guard);
    } catch (error) {
      if (guard.isCurrent()) {
        params.setSendStatusKey('app.error.sendFailed', { message: params.toErrorMessage(error) });
      }
    } finally {
      if (sendingOwner === owner) {
        sendingOwner = null;
        params.isSending.value = false;
      }
    }
  }

  return { sendMessage };
}
