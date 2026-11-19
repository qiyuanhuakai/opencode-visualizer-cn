// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntimeServices } from '../../bridge/runtime/runtimeServices.js';
import type { RuntimeDriverFactory } from '../../bridge/runtime/runtimeDriverFactories.js';
import { createInstanceOperations } from '../../shared/runtime/native/codex/instanceOperations.js';
import { createOperationJournal, fingerprint } from '../../bridge/runtime/operationJournal.js';
import {
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseSessionRef,
} from '../../shared/runtime/identity.js';
import {
  objectFields,
  textValue,
  jsonValue,
  type JsonValue,
} from '../../shared/runtime/capabilities.js';
import { unsupported, type HarnessRegistration } from '../../shared/runtime/harnessContract.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it('binds actual writer execution to its Git worktree, reviews immutable bytes, refuses moved/dirty targets, and integrates only after executable criteria pass', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'vis-host-production-'));
  cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));
  const repository = path.join(stateRoot, 'repository');
  execFileSync('git', ['init', repository], { stdio: 'ignore' });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('config', 'user.name', 'Host Production Test');
  git('config', 'user.email', 'host-test@localhost');
  await writeFile(path.join(repository, 'base.txt'), 'unchanged\n');
  git('add', 'base.txt');
  git('commit', '-m', 'base');
  const originalHead = git('rev-parse', 'HEAD'),
    branch = git('branch', '--show-current');
  const nativeDirectories = new Map<string, string>([['owner', repository]]),
    executedDirectories: string[] = [];
  let owner: ReturnType<typeof parseSessionRef> | undefined;
  const factory: RuntimeDriverFactory = async (context) => {
    const identity = {
      environmentId: parseEnvironmentId(context.environmentId),
      harnessInstanceId: parseHarnessInstanceId(context.harnessInstanceId),
    };
    owner = parseSessionRef({ ...identity, nativeSessionId: 'owner' });
    const instance = createInstanceOperations({
      store: context.store,
      scope: { ...identity, epoch: context.epoch, processGeneration: 1 },
      isCurrent: () => true,
      fingerprint,
      newId: randomUUID,
    });
    const journal = createOperationJournal({ store: context.store, isProcessCurrent: () => true });
    const supported = { state: 'supported' as const },
      denied = unsupported('Controlled fixture does not implement this operation');
    const registration: HarnessRegistration = {
      manifest: {
        ...identity,
        kind: 'codex',
        protocolVersion: 1,
        core: {
          inspect: supported,
          listSessionPage: supported,
          getSession: supported,
          createSession: supported,
          send: supported,
          readHistoryPage: denied,
          openHistory: denied,
          cancel: denied,
          respondInteraction: denied,
          subscribe: denied,
          close: supported,
        },
        extensions: [],
        capabilities: {},
      },
      driver: {
        native: {},
        core: {
          inspect: () => ({ state: 'ready', protocolVersion: 1 }),
          listSessionPage: () => ({
            items: [...nativeDirectories].map(([nativeSessionId, directory]) => ({
              session: { ...identity, nativeSessionId },
              cwd: directory,
              title: nativeSessionId,
              archived: false,
            })),
            cursor: null,
            completeness: 'complete',
          }),
          getSession: (input) => ({
            session: input.session,
            directory: nativeDirectories.get(input.session?.nativeSessionId ?? ''),
          }),
          createSession: async (input) => {
            const params = objectFields(input.params, [
              'workspaceKey',
              'directory',
              'idempotencyKey',
              'native',
            ]);
            const directory = textValue(params.directory, 'directory');
            const accepted = await instance.accept({
              method: 'thread/start',
              idempotencyKey: textValue(params.idempotencyKey, 'key'),
              payload: { directory },
            });
            const result = await instance.execute(accepted.operationId, async () => {
              const nativeSessionId = randomUUID();
              nativeDirectories.set(nativeSessionId, directory);
              return { session: parseSessionRef({ ...identity, nativeSessionId }) };
            });
            return result;
          },
          send: async (input) => {
            if (!input.session) throw new Error('Missing session');
            const session = input.session;
            const params = objectFields(input.params, ['idempotencyKey', 'native']);
            const scope = {
              target: identity.environmentId,
              epoch: context.epoch,
              processGeneration: 1,
              session: input.session,
            };
            const accepted = await journal.accept({
              scope,
              method: 'send',
              idempotencyKey: textValue(params.idempotencyKey, 'key'),
              payload: jsonValue(params.native),
            });
            const result = await journal.execute(accepted.operationId, scope, () => {
              const cwd = nativeDirectories.get(session.nativeSessionId);
              if (!cwd) throw new Error('Missing native cwd');
              const observed = execFileSync(
                process.execPath,
                [
                  '-e',
                  "require('fs').writeFileSync('proof.txt','writer output\\n');process.stdout.write(process.cwd())",
                ],
                { cwd, encoding: 'utf8' },
              );
              executedDirectories.push(observed);
              return { executed: true };
            });
            await journal.terminal(accepted.operationId, scope, 'completed');
            return result;
          },
          close: () => ({ closed: true }),
        },
      },
    };
    return { registration, close: async () => {} };
  };
  const serviceOptions: Parameters<typeof createRuntimeServices>[0] = {
    environmentId: randomUUID(),
    stateRoot,
    role: 'local',
    roots: [{ root: repository, permissions: ['read', 'write', 'command', 'pty'] }],
    config: {
      version: 1,
      nativeServices: { codex: true, opencode: false, 'kimi-web': false, dsh: false },
      acpAgents: [],
    },
    factories: { codex: factory },
    nativeSupervisor: { start: async () => [], stop: async () => {}, getStatus: () => [] },
    acpManager: {
      reconcile: async () => [],
      stopAll: async () => {},
      getStatus: () => [],
      attach: (): never => {
        throw new Error('Unused ACP fixture');
      },
    },
    runtime: { mutate: (action) => action() },
  };
  let services = await createRuntimeServices(serviceOptions);
  cleanups.push(() => services.close());
  await services.start();
  if (!owner) throw new Error('Controlled native driver did not start');
  const context = {
    target: services.target,
    permissions: services.grant.permissions,
    workspaceKeys: services.grant.workspaceKeys,
  };
  async function mutate(domain: string, operation: string, args: JsonValue) {
    const result = await services.hostServices.mutate(
      { domain, operation, args },
      { ...context, idempotencyKey: randomUUID(), onAccepted() {} },
    );
    return Object.fromEntries(
      Object.entries(objectFields(result.value, [], Object.keys(result.value ?? {}))).map(
        ([key, value]) => [key, jsonValue(value)],
      ),
    );
  }
  async function read(domain: string, operation: string, args: JsonValue) {
    return services.hostServices.read({ domain, operation, args }, context);
  }
  const team = await mutate('collaboration', 'createTeam', { name: 'Native writer' });
  const task = await mutate('collaboration', 'createTask', {
    teamId: team.teamId,
    title: 'Write proof',
    criteria: [{ id: 'proof', text: 'Proof file contains exact output', required: true }],
    owner: { participantId: randomUUID(), session: owner },
  });
  const lease = await mutate('writer', 'allocate', { taskId: task.taskId, repository });
  const dispatched = await mutate('collaboration', 'dispatch', { taskId: task.taskId });
  const attemptId = textValue(
    objectFields(dispatched.attempt, [], Object.keys(dispatched.attempt ?? {})).attemptId,
    'attemptId',
  );
  await mutate('collaboration', 'send', { attemptId });
  expect(
    await read('collaboration', 'taskDetails', { taskId: task.taskId, limit: 1 }),
  ).toMatchObject({
    task: { taskId: task.taskId },
    attempts: [{ attemptId }],
    writers: [{ leaseId: lease.leaseId }],
    bindings: [{ leaseId: lease.leaseId, phase: 'ready' }],
    pagination: { cursor: null, counts: { attempts: 1 } },
  });
  expect(executedDirectories).toEqual([lease.nativeCwd]);
  expect(executedDirectories).not.toContain(repository);
  await expect(readFile(path.join(repository, 'proof.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await read('collaboration', 'task', { taskId: task.taskId })).toMatchObject({
    state: 'review',
    owner: { session: { nativeSessionId: expect.not.stringMatching(/^owner$/) } },
  });
  const captured = await mutate('artifact', 'capture', { leaseId: lease.leaseId });
  expect(
    await read('artifact', 'entries', { artifactHash: captured.artifactHash, limit: 1 }),
  ).toMatchObject({ entries: [{ path: 'proof.txt' }], pagination: { cursor: null } });
  expect(
    await read('artifact', 'content', {
      artifactHash: captured.artifactHash,
      path: 'proof.txt',
      limit: 7,
    }),
  ).toMatchObject({ text: 'writer ', nextOffset: 7 });
  expect(
    await read('artifact', 'content', {
      artifactHash: captured.artifactHash,
      path: 'proof.txt',
      offset: 7,
    }),
  ).toMatchObject({ text: 'output\n', nextOffset: null });
  await expect(
    read('artifact', 'content', { artifactHash: captured.artifactHash, path: '../private' }),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  await mutate('artifact', 'apply', {
    artifactHash: captured.artifactHash,
    target: repository,
    dryRun: true,
  });
  await writeFile(path.join(repository, 'dirty.txt'), 'retain');
  await expect(
    mutate('artifact', 'apply', {
      artifactHash: captured.artifactHash,
      target: repository,
      dryRun: true,
    }),
  ).rejects.toMatchObject({ code: 'conflict', field: 'host.artifact_target_dirty' });
  expect(await readFile(path.join(repository, 'dirty.txt'), 'utf8')).toBe('retain');
  await rm(path.join(repository, 'dirty.txt'));
  await mutate('collaboration', 'registerDeliverable', {
    taskId: task.taskId,
    deliverable: { deliverableId: randomUUID(), artifactHash: captured.artifactHash },
  });
  await mutate('collaboration', 'submitForReview', { taskId: task.taskId, reviewer: 'reviewer' });
  await mutate('collaboration', 'review', {
    taskId: task.taskId,
    reviewer: 'reviewer',
    decision: 'approved',
  });
  await expect(mutate('artifact', 'review', { artifactHash: captured.artifactHash, repository, target: branch })).rejects.toMatchObject({ code: 'conflict', field: 'host.integration_target_checked_out' });
  const integrationBranch = 'reviewed-result';
  git('branch', integrationBranch);
  const review = await mutate('artifact', 'review', {
    artifactHash: captured.artifactHash,
    repository,
    target: integrationBranch,
  });
  const checkedOutTarget = path.join(stateRoot, 'checked-out-target');
  git('worktree', 'add', checkedOutTarget, integrationBranch);
  await expect(mutate('artifact', 'approve', { reviewId: review.reviewId })).rejects.toMatchObject({ code: 'conflict', field: 'host.integration_target_checked_out' });
  git('worktree', 'remove', checkedOutTarget);
  const approval = await mutate('artifact', 'approve', { reviewId: review.reviewId });
  git('worktree', 'add', checkedOutTarget, integrationBranch);
  await expect(mutate('artifact', 'integrate', { approvalId: approval.approvalId, tests: [{ criterionId: 'proof', command: process.execPath, args: ['-e', 'process.exit(0)'] }] })).rejects.toMatchObject({ code: 'conflict', field: 'host.integration_target_checked_out' });
  git('worktree', 'remove', checkedOutTarget);
  await expect(
    mutate('artifact', 'apply', {
      artifactHash: captured.artifactHash,
      target: repository,
      approved: true,
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
  const failed = await mutate('artifact', 'integrate', {
    approvalId: approval.approvalId,
    tests: [{ criterionId: 'proof', command: process.execPath, args: ['-e', 'process.exit(1)'] }],
  });
  expect(failed).toMatchObject({ ok: false, outcome: 'tests_failed' });
  expect(git('rev-parse', 'HEAD')).toBe(originalHead);
  const integrated = await mutate('artifact', 'integrate', {
    approvalId: approval.approvalId,
    tests: [
      {
        criterionId: 'proof',
        command: process.execPath,
        args: [
          '-e',
          "require('assert').equal(require('fs').readFileSync('proof.txt','utf8'),'writer output\\n')",
        ],
      },
    ],
  });
  expect(integrated).toMatchObject({
    ok: true,
    outcome: 'integrated',
    taskId: task.taskId,
    tests: [{ exitCode: 0 }],
    fastForward: { applied: true },
  });
  expect(git('show', `${integrationBranch}:proof.txt`)).toBe('writer output');
  expect(git('rev-parse', 'HEAD')).toBe(originalHead);
  expect(git('status', '--porcelain')).toBe('');
  await expect(readFile(path.join(repository, 'proof.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  git('commit', '--allow-empty', '-m', 'Move source HEAD after integration');
  await expect(
    mutate('artifact', 'apply', {
      artifactHash: captured.artifactHash,
      target: repository,
      dryRun: true,
    }),
  ).rejects.toMatchObject({ code: 'conflict', field: 'host.artifact_head_moved' });
  await services.close();
  services = await createRuntimeServices({
    ...serviceOptions,
    roots: [{ root: repository, permissions: ['read', 'write'] }],
  });
  await services.start();
  await expect(
    mutate('artifact', 'integrate', {
      approvalId: approval.approvalId,
      tests: [{ criterionId: 'proof', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    }),
  ).rejects.toMatchObject({ code: 'unauthorized', field: 'host.integration_command' });
  expect(await read('artifact', 'workflow', { artifactHash: captured.artifactHash })).toMatchObject(
    {
      reviews: [{ reviewId: review.reviewId }],
      approvals: [{ approvalId: approval.approvalId }],
      integrations: [{ ok: false }, { ok: true }],
      current: { approval: { approvalId: approval.approvalId }, integration: { ok: true } },
    },
  );
});
