import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acpBridgeWebSocketUrl, normalizeAcpBridgeUrl } from './backends/acp/bridgeUrl';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const appSource = source('app/App.vue');
const permissionStoreSource = source('app/backends/acp/permissionStore.ts');
const permissionSource = source('app/components/ToolWindow/Permission.vue');
const inputSource = source('app/components/InputPanel.vue');
const handlerSource = source('bridge/acpClientMethodHandler.js');
const processManagerSource = source('bridge/acpProcessManager.js');

function inputBlock(name: string) {
  const marker = `name="${name}"`;
  const index = appSource.indexOf(marker);
  return index < 0 ? '' : appSource.slice(Math.max(0, index - 500), index + 300);
}

describe('ACP final blocker regressions', () => {
  it('only exposes Always when the agent offers allow_always', () => {
    expect(permissionStoreSource).toContain(
      "params.options.some((option) => option.kind === 'allow_always') ? ['*'] : []",
    );
    expect(permissionSource).toContain('v-if="request.always.length > 0"');
  });

  it('keeps localhost persisted while using IPv4 loopback for the ACP socket', () => {
    expect(normalizeAcpBridgeUrl('ws://localhost:23004')).toBe('ws://localhost:23004');
    expect(acpBridgeWebSocketUrl('ws://localhost:23004', 'oh-my-pi')).toBe(
      'ws://127.0.0.1:23004/acp/oh-my-pi',
    );
  });

  it('bounds long slash menus to the viewport with a stable scrollbar', () => {
    expect(inputSource).toContain('max-height: min(20rem, calc(100dvh - 18rem));');
    expect(inputSource).toContain('scrollbar-gutter: stable;');
  });

  it('keeps backend tokens and ACP archived state isolated', () => {
    const codexBlock = inputBlock('codexBridgeToken');
    const acpBlock = inputBlock('acpBridgeToken');
    expect(codexBlock).toContain('v-model="loginCodexBridgeToken"');
    expect(codexBlock).not.toContain('loginAcpBridgeToken');
    expect(acpBlock).toContain('v-model="loginAcpBridgeToken"');
    expect(acpBlock).not.toContain('loginCodexBridgeToken');
    expect(appSource).toContain('timeArchived: info.time?.archived');
  });

  it('releases agent-owned reverse terminals when an ACP process stops', () => {
    expect(handlerSource).toContain('handler.releaseAgent = async (agentId) =>');
    expect(handlerSource).toContain('terminalManager.release(terminalId)');
    expect(handlerSource).toContain('pendingSessions.clear()');
    expect(handlerSource).toContain('sessionRoots.clear()');
    expect(processManagerSource).toContain(
      'await Promise.all([releaseEntry(entry), stopAcpChild(entry.child)]);',
    );
  });
});
