// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRuntimeServices } from '../../bridge/runtime/runtimeServices.js';
import { createAcpProcessManager } from '../../bridge/acpProcessManager.js';
import {
  jsonValue,
  objectFields,
  textValue,
  type JsonValue,
} from '../../shared/runtime/capabilities.js';
import { decodeRepoKey, parseSessionRef } from '../../shared/runtime/identity.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('executes ACP writers in separate processes and worktrees, refuses reverse writes to the original repository, and reloads the same native owners after restart without resending', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'vis-acp-writer-'));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  const repository = path.join(stateRoot, 'repository');
  execFileSync('git', ['init', repository], { stdio: 'ignore' });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('config', 'user.name', 'ACP Writer Test');
  git('config', 'user.email', 'writer@localhost');
  await writeFile(path.join(repository, 'original.txt'), 'original\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const trace = path.join(stateRoot, 'trace.jsonl'),
    script = fileURLToPath(new URL('../../scripts/qa/runtime-v090-cases/acp-writer-fixture.mjs', import.meta.url));
  const agent = {
    id: 'writer-fixture',
    name: 'Writer fixture',
    enabled: true,
    command: process.execPath,
    args: [script],
    env: { WRITER_TRACE: trace, ORIGINAL_REPOSITORY: repository },
  };
  const manager = createAcpProcessManager();
  cleanup.push(() => manager.stopAll());
  await manager.reconcile([agent]);
  const options: Parameters<typeof createRuntimeServices>[0] = {
    environmentId: randomUUID(),
    stateRoot,
    role: 'local',
    roots: [{ root: repository, permissions: ['read', 'write', 'command', 'reverse'] }],
    config: {
      version: 1,
      nativeServices: { codex: false, opencode: false, 'kimi-web': false, dsh: false },
      acpAgents: [agent],
    },
    nativeSupervisor: { start: async () => [], stop: async () => {}, getStatus: () => [] },
    acpManager: manager,
    runtime: { mutate: (action) => action() },
  };
  let services = await createRuntimeServices(options);
  cleanup.push(() => services.close());
  await services.start();
  const manifest = services.registry.list().find((item) => item.kind === 'acp');
  expect(manifest?.core.send.state).toBe('supported');
  if (!manifest) throw new Error('Missing ACP manifest');
  const owner = parseSessionRef({
    environmentId: services.target,
    harnessInstanceId: manifest.harnessInstanceId,
    nativeSessionId: 'owner',
  });
  const context = {
    target: services.target,
    permissions: services.grant.permissions,
    workspaceKeys: services.grant.workspaceKeys,
  };
  expect(await services.hostServices.read({ domain: 'thread', operation: 'manifest', args: { session: owner } }, context)).toEqual(manifest);
  expect(await services.hostServices.read({ domain: 'thread', operation: 'selection', args: { session: owner } }, context)).toMatchObject({ manifest, session: owner, directory: repository, workspaceKey: services.workspace.workspaces[0]?.key });
  await expect(services.hostServices.read({ domain: 'thread', operation: 'manifest', args: { session: { ...owner, nativeSessionId: 'unknown-owner' } } }, context)).rejects.toThrow('unauthorized');
  const fields = (value: unknown) =>
    Object.fromEntries(
      Object.entries(objectFields(value, [], Object.keys(Object(value)))).map(([key, item]) => [
        key,
        jsonValue(item),
      ]),
    );
  async function mutate(domain: string, operation: string, args: JsonValue) {
    const result = await services.hostServices.mutate(
      { domain, operation, args },
      { ...context, idempotencyKey: randomUUID(), onAccepted() {} },
    );
    return fields(result.value);
  }
  const team = await mutate('collaboration', 'createTeam', { name: 'ACP writers' });
  const leases: Record<string, JsonValue>[] = [],
    sessions: ReturnType<typeof parseSessionRef>[] = [];
  for (let index = 0; index < 2; index++) {
    const task = await mutate('collaboration', 'createTask', {
      teamId: team.teamId,
      title: 'Write proof',
      criteria: [{ id: 'proof', text: 'Writes proof in the leased directory', required: true }],
      owner: { participantId: randomUUID(), session: owner },
    });
    const lease = await mutate('writer', 'allocate', { taskId: task.taskId, repository });
    leases.push(lease);
    const dispatch = await mutate('collaboration', 'dispatch', { taskId: task.taskId });
    const attempt = fields(dispatch.attempt);
    const boundTask = fields(
      await services.hostServices.read(
        { domain: 'collaboration', operation: 'task', args: { taskId: task.taskId } },
        context,
      ),
    );
    sessions.push(parseSessionRef(fields(boundTask.owner).session));
    await mutate('collaboration', 'send', { attemptId: attempt.attemptId });
    expect(await readFile(path.join(textValue(lease.nativeCwd, 'cwd'), 'proof.txt'), 'utf8')).toBe(
      'ACP writer output\n',
    );
    expect(
      await readFile(path.join(textValue(lease.nativeCwd, 'cwd'), 'terminal.txt'), 'utf8'),
    ).toBe(lease.nativeCwd);
  }
  expect(new Set(sessions.map((session) => session.harnessInstanceId)).size).toBe(2);
  expect(sessions.every((session) => session.nativeSessionId === 'same-native-id')).toBe(true);
  expect(sessions.every((session) => session.harnessInstanceId !== owner.harnessInstanceId)).toBe(
    true,
  );
  expect(git('status', '--porcelain')).toBe('');
  const before = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => fields(JSON.parse(line)));
  const completed = before.filter((entry) => entry.event === 'writer-completed');
  expect(completed).toHaveLength(2);
  expect(new Set(completed.map((entry) => entry.pid)).size).toBe(2);
  for (const entry of completed) expect(fields(entry.forbidden).error).toBeTruthy();
  const firstLease = leases[0];
  if (!firstLease) throw new Error('Missing writer lease');
  const firstSession = sessions[0], workspace = services.workspace.workspaces[0];
  if (!firstSession || !workspace) throw new Error('Missing writer scope');
  expect((await services.store.get({ collection: 'workspaces', key: workspace.key }))?.value).toMatchObject({ gitKind: 'unknown', repoKey: null });
  const selectedRepository = await services.hostServices.read({ domain: 'thread', operation: 'repository', args: { session: owner } }, context);
  expect(selectedRepository).toMatchObject({ repoKey: expect.any(String), root: repository, branch: execFileSync('git', ['-C', repository, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim() });
  const indexedWorkspace = await services.store.get({ collection: 'workspaces', key: workspace.key });
  const repo = decodeRepoKey(textValue(fields(indexedWorkspace?.value).repoKey, 'repoKey'));
  const thread = await mutate('thread', 'bind', { session: owner, repo });
  const participant = await mutate('thread', 'join', { threadId: thread.threadId, session: firstSession, repo });
  const evidence = await mutate('handoff', 'captureEvidence', { threadId: thread.threadId, kind: 'file', path: 'original.txt' });
  const evidenceRef = { hash: evidence.hash, bytes: evidence.bytes, target: evidence.target };
  const carried = await mutate('handoff', 'begin', {
    threadId: thread.threadId, sourceParticipantId: thread.activeParticipantId, targetParticipantId: participant.participantId,
    entries: [{ class: 'artifact', origin: evidence.origin, evidence: evidenceRef, text: 'Actual target worktree evidence' }],
  });
  const evidenceCall = { domain: 'handoff', operation: 'evidencePage', args: { handoffId: carried.handoffId, ref: evidenceRef, currentTarget: evidence.target, offset: 0, length: 65536 } };
  const targetEvidence = await services.hostServices.read(evidenceCall, context);
  expect(targetEvidence).toMatchObject({ available: true, data: Buffer.from('original\n').toString('base64') });
  const targetFile = path.join(textValue(firstLease.nativeCwd, 'nativeCwd'), 'original.txt');
  await writeFile(targetFile, 'changed in target writer only\n');
  await expect(services.hostServices.read(evidenceCall, context)).rejects.toMatchObject({ code: 'conflict', field: 'evidence_changed' });
  expect(await readFile(path.join(repository, 'original.txt'), 'utf8')).toBe('original\n');
  await writeFile(targetFile, 'original\n');
  await mutate('handoff', 'attach', { handoffId: carried.handoffId });
  await mutate('handoff', 'prepare', { handoffId: carried.handoffId, prompt: 'Continue with verified bounded context' });
  await mutate('handoff', 'deliver', { handoffId: carried.handoffId });
  await expect.poll(() => services.hostServices.read({ domain: 'handoff', operation: 'handoff', args: { handoffId: carried.handoffId } }, context)).toMatchObject({ active: true, observed: true });
  const nativeContextTrace = (await readFile(trace, 'utf8')).trim().split('\n').map(line => fields(JSON.parse(line)));
  const nativeContextPrompt = JSON.stringify(nativeContextTrace.filter(entry => entry.method === 'session/prompt').at(-1));
  expect(nativeContextPrompt).toContain('Continue with verified bounded context');
  expect(nativeContextPrompt).toContain('Actual target worktree evidence');
  expect(nativeContextPrompt).toContain(textValue(fields(carried.checkpoint).digest, 'checkpoint digest'));
  const captured = await mutate('artifact', 'capture', { leaseId: firstLease.leaseId });
  expect(
    await services.hostServices.read(
      { domain: 'artifact', operation: 'content', args: { artifactHash: captured.artifactHash, path: 'proof.txt' } },
      context,
    ),
  ).toMatchObject({ text: 'ACP writer output\n', nextOffset: null });
  await mutate('collaboration', 'registerDeliverable', {
    taskId: firstLease.taskId,
    deliverable: { deliverableId: randomUUID(), artifactHash: captured.artifactHash },
  });
  await mutate('collaboration', 'submitForReview', { taskId: firstLease.taskId, reviewer: 'reviewer' });
  await mutate('collaboration', 'review', { taskId: firstLease.taskId, reviewer: 'reviewer', decision: 'approved' });
  const integrationBranch = 'reviewed-acp-result';
  git('branch', integrationBranch);
  const review = await mutate('artifact', 'review', { artifactHash: captured.artifactHash, repository, target: integrationBranch });
  const approval = await mutate('artifact', 'approve', { reviewId: review.reviewId });
  const integrated = await mutate('artifact', 'integrate', {
    approvalId: approval.approvalId,
    tests: [{ criterionId: 'proof', command: process.execPath, args: ['-e', "require('assert').equal(require('fs').readFileSync('proof.txt','utf8'),'ACP writer output\\n');require('assert').ok(require('fs').readFileSync('terminal.txt','utf8').includes('/writers/writer-'))"] }],
  });
  expect(integrated).toMatchObject({ ok: true, outcome: 'integrated', taskId: firstLease.taskId, tests: [{ exitCode: 0 }], fastForward: { applied: true } });
  expect(git('show', `${integrationBranch}:proof.txt`)).toBe('ACP writer output');
  expect(git('status', '--porcelain')).toBe('');
  expect(await readFile(path.join(repository, 'original.txt'), 'utf8')).toBe('original\n');
  await expect(readFile(path.join(repository, 'proof.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await services.close();
  await manager.reconcile([agent]);
  services = await createRuntimeServices(options);
  await services.start();
  expect(await services.hostServices.read(evidenceCall, context)).toMatchObject({ available: true, data: Buffer.from('original\n').toString('base64') });
  expect(await services.hostServices.read({ domain: 'artifact', operation: 'workflow', args: { artifactHash: captured.artifactHash } }, context)).toMatchObject({
    current: { review: { reviewId: review.reviewId }, approval: { approvalId: approval.approvalId }, integration: { operationId: integrated.operationId, ok: true } },
  });
  for (const session of sessions) {
    expect(
      services.registry
        .list()
        .some((entry) => entry.harnessInstanceId === session.harnessInstanceId),
    ).toBe(true);
    expect(
      await services.registry.invoke({
        environmentId: session.environmentId,
        harnessInstanceId: session.harnessInstanceId,
        session,
        channel: 'core',
        operation: 'getSession',
        params: services.authority(session.harnessInstanceId),
      }),
    ).toMatchObject({ session, directory: expect.stringContaining('/writers/writer-') });
  }
  const after = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => fields(JSON.parse(line)));
  expect(after.filter((entry) => entry.method === 'session/prompt')).toHaveLength(3);
  expect(after.filter((entry) => entry.method === 'session/load')).toHaveLength(2);
  await services.close();
  const noLoadAgent = { ...agent, env: { ...agent.env, NO_LOAD: '1' } };
  await manager.reconcile([noLoadAgent]);
  services = await createRuntimeServices({
    ...options,
    config: { ...options.config, acpAgents: [noLoadAgent] },
  });
  await services.start();
  for (const lease of leases) {
    expect(
      await services.hostServices.read(
        { domain: 'writer', operation: 'binding', args: { leaseId: lease.leaseId } },
        context,
      ),
    ).toMatchObject({
      phase: 'reconciling',
      lastError: { code: 'unsupported', field: 'host.writer_load_unsupported' },
    });
    await expect(mutate('writer', 'reconnect', { leaseId: lease.leaseId })).rejects.toMatchObject({
      code: 'unsupported',
      field: 'host.writer_load_unsupported',
    });
  }
  const finalTrace = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => fields(JSON.parse(line)));
  expect(finalTrace.filter((entry) => entry.method === 'session/prompt')).toHaveLength(3);
  await services.close();
  await manager.stopAll();
  const childPids = new Set(finalTrace.map((entry) => entry.pid));
  for (const pid of childPids) {
    if (typeof pid !== 'number') throw new Error('Missing child pid');
    let stopped = false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      stopped = error instanceof Error && 'code' in error && error.code === 'ESRCH';
    }
    expect(stopped).toBe(true);
  }
  if (process.env.VIS_RUNTIME_QA_EVIDENCE)
    await writeFile(
      path.join(process.env.VIS_RUNTIME_QA_EVIDENCE, 'acp-writer-trace.json'),
      JSON.stringify(
        {
          leases,
          sessions,
          artifact: { captured, review, approval, integrated },
          handoffEvidence: { carried, evidence, targetEvidence, nativeContextPrompt, changedWriterTargetRefused: true, originalSourceUnchanged: true, restoredPageVerified: true, nativeObserved: true },
          trace: finalTrace,
          unsupportedReloadExplicit: true,
          childrenStopped: true,
        },
        null,
        2,
      ),
    );
}, 45_000);
