// @vitest-environment node
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntimeServices } from '../../bridge/runtime/runtimeServices.js';
import { unavailableRegistration } from '../../bridge/runtime/runtimeDriverFactories.js';
import { decodeRepoKey, parseSessionRef, parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import type { HostMutationCall, HostReadCall } from '../../shared/runtime/hostWire.js';
import { hostArray, hostObject, hostString } from './hostCollaborationViews';

it('pages 51 maximum-length fanouts as bounded metadata while preserving a separately selected recipient list across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vis-fanout-pages-'));
  const repository = path.join(root, 'repository');
  execFileSync('git', ['init', '--quiet', repository]);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Vis QA', '-c', 'user.email=qa@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'base']);
  const options: Parameters<typeof createRuntimeServices>[0] = {
    environmentId: randomUUID(), stateRoot: root, role: 'local',
    roots: [{ root: repository, permissions: ['read', 'write', 'command'] }],
    config: { version: 1, nativeServices: { codex: true, opencode: false, 'kimi-web': false, dsh: false }, acpAgents: [] },
    nativeSupervisor: { start: async () => [], stop: async () => {}, getStatus: () => [] },
    acpManager: { reconcile: async () => [], stopAll: async () => {}, getStatus: () => [], attach() { throw new Error('ACP is disabled'); } },
    runtime: { mutate: action => action() },
    factories: { codex: async context => {
      const identity = { environmentId: parseEnvironmentId(context.environmentId), harnessInstanceId: parseHarnessInstanceId(context.harnessInstanceId), kind: 'codex' as const };
      const empty = unavailableRegistration(identity, 'starting');
      return { registration: {
        manifest: { ...empty.manifest, core: { ...empty.manifest.core, inspect: { state: 'supported' }, listSessionPage: { state: 'supported' } } },
        driver: { native: {}, core: {
          inspect: () => ({ state: 'ready' }),
          listSessionPage: () => ({ items: Array.from({ length: 32 }, (_, index) => ({ session: { environmentId: identity.environmentId, harnessInstanceId: identity.harnessInstanceId, nativeSessionId: `member-${index}` }, cwd: repository, title: `Member ${index}` })), cursor: null, completeness: 'complete' }),
        } },
      }, close: async () => {} };
    } },
  };
  let services = await createRuntimeServices(options);
  try {
    await services.start();
    const context = () => ({ target: services.target, permissions: services.grant.permissions, workspaceKeys: services.grant.workspaceKeys });
    const read = (call: HostReadCall) => services.hostServices.read(call, context()).then(hostObject);
    const mutate = async (call: HostMutationCall) => hostObject((await services.hostServices.mutate(call, { ...context(), idempotencyKey: randomUUID(), onAccepted() {} })).value);
    const manifest = services.registry.list().find(item => item.kind === 'codex');
    if (!manifest) throw new Error('Missing source');
    const sessions = Array.from({ length: 32 }, (_, index) => parseSessionRef({ environmentId: services.target, harnessInstanceId: manifest.harnessInstanceId, nativeSessionId: `member-${index}` }));
    const repositoryInfo = await read({ domain: 'thread', operation: 'repository', args: { session: sessions[0]! } });
    const repo = decodeRepoKey(hostString(repositoryInfo.repoKey));
    const thread = await mutate({ domain: 'thread', operation: 'bind', args: { session: sessions[0]!, repo } });
    const threadId = hostString(thread.threadId);
    const binding = await mutate({ domain: 'collaboration', operation: 'openTeam', args: { threadId, name: 'Bounded fanout history' } });
    const teamId = hostString(binding.teamId), targets = [];
    for (const [index, session] of sessions.entries()) {
      const participant = index === 0 ? hostObject(hostArray(thread.participants)[0]) : await mutate({ domain: 'thread', operation: 'join', args: { threadId, session, repo } });
      const participantId = hostString(participant.participantId);
      await mutate({ domain: 'collaboration', operation: 'addMember', args: { teamId, participantId, session, role: 'worker', harnessKind: 'codex' } });
      targets.push({ participantId, session, attachmentPath: 'a'.repeat(1024) });
    }
    let latestId = '';
    for (let index = 0; index < 51; index++) {
      const created = await mutate({ domain: 'fanout', operation: 'createFanout', args: { teamId, threadId, prompt: `${index}:`.padEnd(65536, 'x'), targets } });
      latestId = hostString(created.fanoutId);
      expect(hostString(created.prompt)).toHaveLength(65536);
    }
    const verify = async () => {
      const first = await read({ domain: 'fanout', operation: 'fanoutsPage', args: { teamId, cursor: 0, limit: 50 } });
      const rows = hostArray(first.fanouts).map(hostObject);
      expect(rows).toHaveLength(50);
      expect(rows[0]).toMatchObject({ fanoutId: latestId, recipientCount: 32, targets: [] });
      expect(rows.every(row => !Object.hasOwn(row, 'prompt') && hostString(row.promptPreview).length === 160)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(128 * 1024);
      const second = await read({ domain: 'fanout', operation: 'fanoutsPage', args: { teamId, cursor: 50, limit: 50 } });
      expect(hostArray(second.fanouts)).toHaveLength(1);
      const detail = await read({ domain: 'fanout', operation: 'fanout', args: { fanoutId: latestId } });
      expect(detail).not.toHaveProperty('prompt');
      expect(hostArray(detail.targets)).toHaveLength(32);
      expect(hostObject(hostArray(detail.targets)[0]).session).toEqual(sessions[0]);
    };
    await verify();
    await services.close();
    services = await createRuntimeServices(options);
    await services.start();
    await verify();
  } finally { await services.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
