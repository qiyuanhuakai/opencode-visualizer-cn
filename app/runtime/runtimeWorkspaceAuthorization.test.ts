// @vitest-environment node
//
// R1.workspace-authorization-boundary — reviewer fixes for PR #181:
//   Finding 1 (P1): ACP session creation must be bound to the workspace the caller was
//     granted. A session on a non-bound root must be rejected BEFORE any native session/new.
//   Finding 2 (P2): a session indexed under a subdirectory of an authorized root must pass
//     the dispatch grant check for get/history/send/cancel, while an adjacent directory or a
//     symlink escape is still rejected.
//
// These tests exercise the real modules (runtimeServices discovery, runtimeDispatch grant,
// acpSessions.create + the reverse-call scope) with real temp directories and a controlled
// stdio ACP fixture — no mocks of the graded authorization boundary.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpProcessManager } from '../../bridge/acpProcessManager.js';
import { createAcpDriver } from '../../bridge/runtime/drivers/acpDriver.js';
import { createRuntimeHost } from '../../bridge/runtime/runtimeHost.js';
import { createRuntimeServices } from '../../bridge/runtime/runtimeServices.js';
import { createRuntimeStore } from '../../bridge/runtime/storage/runtimeStore.js';
import { createWorkspaceService } from '../../bridge/runtime/workspaceService.js';
import { CORE_OPERATIONS, unsupported, validateHarnessRegistration } from '../../shared/runtime/harnessContract.js';
import type { CoreOperation, Support } from '../../shared/runtime/harnessContract.js';
import { encodeSessionKey, parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { Result } from '../../shared/runtime/protocol.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function tempRoot(prefix: string, ...children: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  for (const child of children) await mkdir(path.join(root, child), { recursive: true });
  return root;
}
const permissions = ['read', 'write', 'command', 'pty', 'reverse'] as const;
const supervisor = { start: async () => [], stop: async () => {}, getStatus: () => [] };
const acpManager = { reconcile: async () => [], stopAll: async () => {}, getStatus: () => [], attach: (): never => { throw new Error('Disabled ACP must not attach'); } };

// ---------------------------------------------------------------------------------------------
// Finding 2 — discovery/grant/dispatch agree on one authorized root scope per directory
// ---------------------------------------------------------------------------------------------

function controlledAcpRegistration(context: { readonly environmentId: string; readonly harnessInstanceId: string }, directory: string) {
  const core = Object.fromEntries(
    Object.keys(CORE_OPERATIONS).map(name => [
      name,
      name === 'inspect' || name === 'listSessionPage' || name === 'getSession' || name === 'readHistoryPage' ? { state: 'supported' } : unsupported('workspace authorization fixture'),
    ]),
  ) as Record<CoreOperation, Support>;
  const session = { environmentId: context.environmentId, harnessInstanceId: context.harnessInstanceId, nativeSessionId: 'sub-1' };
  return validateHarnessRegistration({
    manifest: { kind: 'acp', environmentId: context.environmentId, harnessInstanceId: context.harnessInstanceId, protocolVersion: 1, core, extensions: [], capabilities: {} },
    driver: {
      core: {
        inspect: () => ({ state: 'ready', protocolVersion: 1 }),
        listSessionPage: async () => ({ items: [{ session, native: { sessionId: 'sub-1', cwd: directory, title: 'subject' } }], cursor: null, status: 'complete' }),
        getSession: () => ({ status: 'partial', reason: 'workspace authorization fixture' }),
        readHistoryPage: () => ({ items: [], status: 'partial', reason: 'workspace authorization fixture' }),
      },
      native: {},
    },
  });
}

async function controlledServices(stateRoot: string, resourceRoot: string, directory: string) {
  const config = { version: 1 as const, nativeServices: { opencode: false, codex: false, 'kimi-web': false, dsh: false }, acpAgents: [{ id: 'qa', name: 'QA', command: process.execPath, args: [], enabled: true }] };
  const services = await createRuntimeServices({
    environmentId: randomUUID(), stateRoot, role: 'local',
    roots: [{ root: resourceRoot, permissions: [...permissions] }],
    config, nativeSupervisor: supervisor, acpManager, runtime: { mutate: operation => operation() },
    factories: { 'acp:qa': async context => ({ registration: controlledAcpRegistration(context, directory), close: async () => {} }) },
  });
  await services.start();
  const manifest = services.registry.list().find(entry => entry.kind === 'acp');
  if (!manifest) throw new TypeError('missing controlled acp manifest');
  return { services, harnessInstanceId: manifest.harnessInstanceId };
}

async function indexedSession(stateRoot: string, resourceRoot: string, directory: string) {
  const { services, harnessInstanceId } = await controlledServices(stateRoot, resourceRoot, directory);
  return { services, harnessInstanceId, session: parseSessionRef({ environmentId: services.target, harnessInstanceId, nativeSessionId: 'sub-1' }) };
}

async function dispatchRequest(services: Awaited<ReturnType<typeof controlledServices>>['services'], harnessInstanceId: string, session: ReturnType<typeof parseSessionRef>, method: 'session.get' | 'session.history' | 'session.send' | 'session.cancel') {
  const host = createRuntimeHost({ environmentId: services.target, role: 'local', services });
  host.start();
  try {
    const scope = host.connect('workspace-authorization-probe');
    const frames: Result[] = [];
    const dispatcher = scope.openRuntime({ send: frame => frames.push(frame), sendBinary() {}, canSend: () => true });
    if (!dispatcher) throw new TypeError('missing dispatcher');
    const hello = dispatcher.hello();
    const mutation = method === 'session.send' || method === 'session.cancel';
    await dispatcher.request({
      version: 1, kind: 'request', target: hello.target, epoch: hello.epoch, generation: hello.generation,
      id: 'probe-' + method, method, params: { harnessInstanceId, session, args: {} },
      ...(mutation ? { idempotencyKey: 'probe-' + method } : {}),
    });
    const result = frames.at(-1);
    if (!result) throw new TypeError('missing dispatch result');
    return result;
  } finally { await host.stop(); }
}

describe('session workspace authorization boundary', () => {
  it('indexes a subdirectory session as the authorized root and grants get/history/send/cancel', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runtime-ws-auth-'));
    temporary.push(root);
    const subdirectory = path.join(root, 'project');
    await mkdir(subdirectory, { recursive: true });
    const { services, harnessInstanceId, session } = await indexedSession(root, root, subdirectory);
    try {
      const row = await services.store.get({ collection: 'session_summaries', key: encodeSessionKey(session) });
      expect(row?.value).toMatchObject({ directory: subdirectory, workspaceKey: services.workspace.workspaces[0]!.key });
      // Reads reach the fixture driver once the summary's subdirectory workspaceKey is inside
      // the granted root. On the unchanged code the grant check rejects it as `unauthorized`.
      for (const method of ['session.get', 'session.history'] as const) {
        expect(await dispatchRequest(services, harnessInstanceId, session, method)).toMatchObject({ ok: true });
      }
      // send/cancel are mutations that the fixture does not journal, so once the workspace
      // grant passes they reach the fixture and report the fixture's own `unsupported`.
      for (const method of ['session.send', 'session.cancel'] as const) {
        expect(await dispatchRequest(services, harnessInstanceId, session, method)).toMatchObject({ ok: false, typedError: { code: 'unsupported' } });
      }
    } finally { await services.close(); }
  });

  it('rejects a session whose directory is adjacent to (not inside) every authorized root', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'runtime-ws-auth-'));
    temporary.push(base);
    const root = path.join(base, 'root');
    const adjacent = path.join(base, 'adjacent');
    await mkdir(root, { recursive: true });
    await mkdir(adjacent, { recursive: true });
    const { services, session } = await indexedSession(base, root, adjacent);
    try {
      const row = await services.store.get({ collection: 'session_summaries', key: encodeSessionKey(session) });
      expect(row?.value).toBeUndefined();
    } finally { await services.close(); }
  });

  it('rejects a symlink that escapes an authorized root', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'runtime-ws-auth-'));
    temporary.push(base);
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    const escape = path.join(root, 'escape');
    await symlink(outside, escape);
    const { services, session } = await indexedSession(base, root, escape);
    try {
      const row = await services.store.get({ collection: 'session_summaries', key: encodeSessionKey(session) });
      expect(row?.value).toBeUndefined();
    } finally { await services.close(); }
  });

  it('binds the reverse-call scope to the authorized root cwd only', async () => {
    const base = await tempRoot('runtime-ws-auth-', 'a', 'b');
    temporary.push(base);
    const target = randomUUID();
    const epoch = randomUUID();
    const harnessInstanceId = randomUUID();
    const workspace = await createWorkspaceService({
      target, epoch,
      roots: [{ root: path.join(base, 'a'), permissions: [...permissions] }, { root: path.join(base, 'b'), permissions: [...permissions] }],
    });
    try {
      const connection = workspace.connect({ target, epoch, generation: 0, subscriberId: randomUUID(), assertCurrent() {} });
      const bound = workspace.workspaces[0]!;
      const other = workspace.workspaces[1]!;
      const owner = connection.reverse.register({ workspaceKey: bound.key, harnessInstanceId, processGeneration: 1, agentId: 'qa', assertProcessCurrent() {} });
      expect(() => owner.observeClientMessage({ id: 'foreign', method: 'session/new', params: { cwd: other.root } })).toThrow('unauthorized');
      owner.observeClientMessage({ id: 'bound', method: 'session/new', params: { cwd: bound.root } });
      owner.observeAgentMessage({ id: 'bound', result: { sessionId: 'bound-session' } });
      const file = path.join(bound.root, 'notes.txt');
      await writeFile(file, 'bound-file');
      await expect(owner.handle({ method: 'fs/read_text_file', params: { sessionId: 'bound-session', path: file } })).resolves.toEqual({ content: 'bound-file' });
      // handle() rejects an unknown session synchronously, before it can read anything.
      expect(() => owner.handle({ method: 'fs/read_text_file', params: { sessionId: 'unknown-session', path: file } })).toThrow('unauthorized');
    } finally { await workspace.close(); }
  });
});

// ---------------------------------------------------------------------------------------------
// Finding 1 — ACP session creation is bound to the authorized workspace
// ---------------------------------------------------------------------------------------------

function frameAgentScript(markerPath: string) {
  const literal = JSON.stringify(markerPath);
  return [
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    `const marker = ${literal};`,
    "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
    '  const message = JSON.parse(line);',
    "  if (message.method === 'initialize') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fixture', version: '1' } } }) + '\\n');",
    "  } else if (message.method === 'session/new') {",
    '    fs.writeFileSync(marker, message.params.cwd);',
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'bound-session' } }) + '\\n');",
    '  }',
    '});',
  ].join('\n');
}

describe('ACP session creation workspace binding', () => {
  it('rejects a non-bound workspace before any native session/new', async () => {
    const base = await tempRoot('acp-workspace-', 'a', 'b');
    temporary.push(base);
    const marker = path.join(base, 'native-cwd.txt');
    const manager = createAcpProcessManager();
    try {
      await manager.reconcile([{ id: 'qa', name: 'QA', command: process.execPath, args: ['-e', frameAgentScript(marker)], enabled: true }]);
      const environmentId = randomUUID();
      const epoch = randomUUID();
      const harnessInstanceId = randomUUID();
      const store = createRuntimeStore({ stateDirectory: path.join(base, 'runtime'), environmentId, ownerId: randomUUID(), epoch });
      await store.ready;
      try {
        const workspace = await createWorkspaceService({
          target: environmentId, epoch,
          roots: [{ root: path.join(base, 'a'), permissions: [...permissions] }, { root: path.join(base, 'b'), permissions: [...permissions] }],
        });
        try {
          const connection = workspace.connect({ target: environmentId, epoch, generation: 0, subscriberId: randomUUID(), assertCurrent() {} });
          const bound = workspace.workspaces[0]!;
          const other = workspace.workspaces[1]!;
          const driver = await createAcpDriver({ store, manager, agentId: 'qa', target: environmentId, harnessInstanceId, epoch, workspace: connection, workspaceKey: bound.key, cwd: bound.root });
          try {
            const createSession = driver.driver.core.createSession;
            if (typeof createSession !== 'function') throw new TypeError('missing createSession');
            const context = (idempotencyKey: string, cwd: string) => ({ environmentId: parseEnvironmentId(environmentId), harnessInstanceId: parseHarnessInstanceId(harnessInstanceId), params: { epoch, processGeneration: driver.binding.processGeneration, idempotencyKey, cwd } });
            await expect(createSession(context('foreign', other.root))).rejects.toMatchObject({ code: 'unauthorized', field: 'acp.workspace' });
            await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
            await createSession(context('bound', bound.root));
            expect(await readFile(marker, 'utf8')).toBe(bound.root);
          } finally { await driver.close(); }
        } finally { await workspace.close(); }
      } finally { await store.close(); }
    } finally { await manager.stopAll(); }
  });
});
