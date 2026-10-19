import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { openAcpEnvironment, authTerminalProbe } from './task-15-fixture.mjs';
import { artifact, writeJson } from '../runtime-v090-evidence.mjs';
import { runInstalledNative } from './task-15-native.mjs';
import { runAcpFaults } from './task-15-faults.mjs';
export const sourceFiles = [
  'bridge/acpProcessManager.js',
  'bridge/acpProcessManager.d.ts',
  'bridge/acpProcessProtocol.js',
  'bridge/acpClientMethodHandler.js',
  ...[
    'acpDriver',
    'acpSessions',
    'acpInteractions',
    'acpRpc',
    'acpMutations',
    'acpExtensions',
  ].flatMap((name) => ['js', 'd.ts'].map((ext) => `bridge/runtime/drivers/${name}.${ext}`)),
  ...['capabilities', 'subscriptions'].flatMap((name) =>
    ['js', 'd.ts'].map((ext) => `shared/runtime/native/acp/${name}.${ext}`),
  ),
];
async function runControlledHappy(context) {
  const scenarios = [],
    artifacts = [];
  const check = (name, observed, expected) => {
    assert.deepEqual(observed, expected, name);
    scenarios.push({ name, assertions: [{ name, observed, expected, passed: true }] });
  };
  const auth = authTerminalProbe();
  const env = await openAcpEnvironment({
    temporaryRoot: context.temporaryRoot,
    agents: [
      { id: 'first', createAuthTerminal: auth.create, env: { ACP_REUSE_REQUEST_ID: '1' } },
      { id: 'second', env: { ACP_CONCURRENT: '1' } },
    ],
  });
  try {
    const [first, second] = env.drivers;
    const a = await first.driver.core.createSession(first.context({ idempotencyKey: 'new-a' }));
    const b = await second.driver.core.createSession(second.context({ idempotencyKey: 'new-b' }));
    await first.driver.native.syncSessionConfig(
      first.context({ idempotencyKey: 'model-config', configId: 'model', value: 'b' }, a.session),
    );
    check(
      'controlled config result updates only its actual native session',
      [
        first.driver.native.getSessionConfigOptions(first.context({}, a.session))[0].currentValue,
        second.driver.native.getSessionConfigOptions(second.context({}, b.session))[0].currentValue,
      ],
      ['b', 'a'],
    );
    await first.driver.native.sendCommand(
      first.context(
        { idempotencyKey: 'slash-command', command: 'qa', arguments: 'scoped' },
        a.session,
      ),
    );
    check(
      'controlled advertised slash command reaches original native session',
      (await first.trace())
        .filter((item) => item.method === 'session/prompt')
        .map((item) => [item.params.sessionId, item.params.prompt[0].text]),
      [[a.session.nativeSessionId, '/qa scoped']],
    );
    check(
      'controlled agents sharing native ID retain composite identity',
      [a.session.nativeSessionId === b.session.nativeSessionId, a.key !== b.key],
      [true, true],
    );
    const observer = first.driver.core.subscribe(
      first.context({ subscriberId: 'window-a' }, a.session),
    );
    const observer2 = first.driver.core.subscribe(
      first.context({ subscriberId: 'window-b' }, a.session),
    );
    const prompt = first.driver.core.send(
      first.context(
        { idempotencyKey: 'prompt-permission', prompt: [{ type: 'text', text: 'permission' }] },
        a.session,
      ),
    );
    const pending = await until(
      async () => first.driver.native.listPendingPermissions(first.context()),
      (items) => items.length === 1,
    );
    observer.detach();
    observer2.detach();
    const reconnect = first.driver.core.subscribe(
      first.context({ subscriberId: 'window-reconnected', after: 0 }, a.session),
    );
    check(
      'controlled pending request survives all UI subscribers detaching',
      reconnect.read().events.some((event) => event.type === 'interaction.pending'),
      true,
    );
    const answer = { outcome: { outcome: 'selected', optionId: 'allow' } };
    const replies = await Promise.allSettled(
      ['one', 'two'].map((idempotencyKey) =>
        first.driver.core.respondInteraction(
          first.context(
            { idempotencyKey, interactionId: pending[0].interactionId, answer },
            a.session,
          ),
        ),
      ),
    );
    check(
      'controlled two-window reply race admits exactly one reply',
      replies.map((item) => item.status).sort(),
      ['fulfilled', 'rejected'],
    );
    const completed = await prompt;
    check(
      'controlled native prompt reaches actual terminal',
      completed.result.stopReason,
      'end_turn',
    );
    const trace = await first.trace();
    check(
      'controlled native upstream observed one initialization and one reply',
      [
        trace.filter((item) => item.method === 'initialize').length,
        trace.filter((item) => item.id === pending[0].nativeRequestId && !item.method).length,
      ],
      [1, 1],
    );
    const page = await first.driver.core.listSessionPage(first.context());
    const final = await first.driver.core.listSessionPage(first.context({ cursor: page.cursor }));
    check(
      'controlled session list paginates without transcript loading',
      [page.status, final.status, final.items[0].session.nativeSessionId],
      ['partial', 'complete', 'second'],
    );
    await first.driver.native['acp.loadSession'](
      first.context({ idempotencyKey: 'load-a' }, a.session),
    );
    await first.driver.native['acp.resumeSession'](
      first.context({ idempotencyKey: 'resume-a' }, a.session),
    );
    check(
      'controlled native load and resume are invoked',
      (await first.trace())
        .filter((item) => ['session/load', 'session/resume'].includes(item.method))
        .map((item) => item.method),
      ['session/load', 'session/resume'],
    );
    const originalInteraction = await env.store.getControl({
      collection: 'interactions',
      key: pending[0].interactionId,
    });
    for (const [driver, base, concurrent] of [
      [first, a.session, false],
      [second, b.session, true],
    ]) {
      const another = { ...base, nativeSessionId: 'parallel-session' };
      await driver.driver.native['acp.loadSession'](
        driver.context({ idempotencyKey: 'parallel-load' }, another),
      );
      const start = (id) =>
        driver.driver.core.send(
          driver.context(
            { idempotencyKey: `queue-${id}`, prompt: [{ type: 'text', text: 'permission' }] },
            id === 'a' ? base : another,
          ),
        );
      const promptA = start('a');
      const currentPending = await until(
        () => driver.driver.native.listPendingPermissions(driver.context()),
        (items) => items.length === 1,
      );
      if (!concurrent) {
        let lateError;
        try {
          await driver.driver.core.respondInteraction(
            driver.context(
              {
                idempotencyKey: 'old-recycled-id-answer',
                interactionId: pending[0].interactionId,
                answer,
              },
              base,
            ),
          );
        } catch (error) {
          lateError = error.reason;
        }
        check(
          'controlled recycled native request ID creates a new parent-bound interaction and rejects old reply',
          [
            currentPending[0].nativeRequestId === pending[0].nativeRequestId,
            currentPending[0].interactionId !== pending[0].interactionId,
            lateError,
            (await driver.trace()).filter(
              (item) => !item.method && item.id === pending[0].nativeRequestId,
            ).length,
          ],
          [true, true, 'interaction_claimed', 1],
        );
      }
      const promptB = start('b');
      if (concurrent)
        await until(
          () => driver.driver.native.listPendingPermissions(driver.context()),
          (items) => items.length === 2,
        );
      else await new Promise((resolve) => setTimeout(resolve, 50));
      const requests = await driver.driver.native.listPendingPermissions(driver.context());
      check(
        `controlled advertised concurrency ${concurrent} controls native simultaneous prompts`,
        requests.length,
        concurrent ? 2 : 1,
      );
      for (const item of requests)
        await driver.driver.core.respondInteraction(
          driver.context(
            {
              idempotencyKey: `queue-reply-${item.interactionId}`,
              interactionId: item.interactionId,
              answer,
            },
            item.session,
          ),
        );
      await promptA;
      if (!concurrent) {
        let duplicateError;
        try {
          await driver.driver.core.respondInteraction(
            driver.context(
              {
                idempotencyKey: 'duplicate-current-recycled-id',
                interactionId: currentPending[0].interactionId,
                answer,
              },
              base,
            ),
          );
        } catch (error) {
          duplicateError = error.reason;
        }
        check(
          'controlled recycled current interaction replies once and preserves original durable record',
          [
            duplicateError,
            (await driver.trace()).filter(
              (message) => !message.method && message.id === pending[0].nativeRequestId,
            ).length,
            await env.store.getControl({
              collection: 'interactions',
              key: pending[0].interactionId,
            }),
          ],
          ['interaction_claimed', 2, originalInteraction],
        );
        const item = (
          await until(
            () => driver.driver.native.listPendingPermissions(driver.context()),
            (items) => items.length === 1,
          )
        )[0];
        await driver.driver.core.respondInteraction(
          driver.context(
            { idempotencyKey: 'queue-final-reply', interactionId: item.interactionId, answer },
            item.session,
          ),
        );
      }
      await promptB;
    }
    reconnect.detach();
    await env.connection.disconnect();
    execFileSync('git', ['init', '--quiet', env.root]);
    const marker = path.join(env.root, 'dirty-marker.txt');
    await writeFile(marker, 'user-owned dirty marker');
    const reverse = await first.driver.core.send(
      first.context(
        { idempotencyKey: 'reverse-tools', prompt: [{ type: 'text', text: 'reverse' }] },
        a.session,
      ),
    );
    check(
      'controlled reverse file and terminal remain process-owned after UI workspace disconnect',
      [reverse.result.reverseFile, reverse.result.reverseCwd],
      ['ACP-owned file\n', env.root],
    );
    check(
      'controlled dirty worktree marker survives reverse tools unchanged',
      [
        await readFile(marker, 'utf8'),
        execFileSync('git', ['-C', env.root, 'status', '--porcelain', '--', 'dirty-marker.txt'], {
          encoding: 'utf8',
        }).trim(),
      ],
      ['user-owned dirty marker', '?? dirty-marker.txt'],
    );
    const forked = await first.driver.native.forkSession(
      first.context({ idempotencyKey: 'fork-session' }, a.session),
    );
    const forkReverse = await first.driver.core.send(
      first.context(
        { idempotencyKey: 'fork-reverse', prompt: [{ type: 'text', text: 'reverse' }] },
        forked.session,
      ),
    );
    check(
      'controlled fork keeps actual native wire and trusted reverse workspace binding',
      [
        forked.session.nativeSessionId,
        forkReverse.result.reverseCwd,
        (await first.trace()).filter((item) => item.method === 'session/fork').length,
      ],
      ['forked-session', env.root, 1],
    );
    const terminal = await first.driver.native.createAgentAuthPty(
      first.context({ methodId: 'qa-auth', idempotencyKey: 'auth-terminal' }),
    );
    const probe = await until(
      () => auth.observed[0],
      (value) => !!value?.output,
    );
    check(
      'controlled auth uses actual managed PTY with private home and original workspace',
      [
        terminal.result.terminalId,
        probe.output.home,
        probe.output.cwd,
        probe.output.pid,
        probe.binding.harnessInstanceId,
      ],
      [probe.terminalId, probe.home, env.root, probe.pid, first.binding.harnessInstanceId],
    );
    await first.close();
    check('controlled native owner closes auth PTY', probe.closed, true);
    return {
      scenarios,
      artifacts,
      versions: { fixture: 'controlled ACP stdio server; not installed-native proof' },
    };
  } finally {
    const wire = path.join(context.outDir, `${context.case}-controlled-wire.json`);
    writeJson(wire, env.wire);
    artifacts.push(artifact(wire, 'controlled-native-stdio'));
    const cleanup = await env.close();
    const file = path.join(context.outDir, `${context.case}-controlled-resources.json`);
    writeJson(file, cleanup);
    artifacts.push(artifact(file, 'resource-cleanup'));
    const authFile = path.join(context.outDir, `${context.case}-auth-pty.json`);
    writeJson(authFile, auth.observed);
    artifacts.push(artifact(authFile, 'real-managed-auth-pty'));
  }
}
export async function until(read, predicate) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error('Timed out awaiting observable ACP state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runControlledFailure(context) {
  const scenarios = [],
    artifacts = [];
  const check = (name, observed, expected) => {
    assert.deepEqual(observed, expected, name);
    scenarios.push({
      name: `failure ${name}`,
      assertions: [{ name, observed, expected, passed: true }],
    });
  };
  const reject = async (name, action, reason) => {
    let observed;
    try {
      await action();
    } catch (error) {
      observed = error.reason;
    }
    check(name, observed, reason);
  };
  const env = await openAcpEnvironment({
    temporaryRoot: context.temporaryRoot,
    agents: [
      { id: 'first', env: { ACP_REPEAT_CURSOR: '1', ACP_REUSE_REQUEST_ID: '1' } },
      { id: 'second', env: { ACP_NO_LIST: '1' } },
    ],
  });
  try {
    const [first, second] = env.drivers;
    const created = await first.driver.core.createSession(first.context({ idempotencyKey: 'new' }));
    const session = created.session;
    const other = await second.driver.core.createSession(second.context({ idempotencyKey: 'new' }));
    const page = await first.driver.core.listSessionPage(first.context());
    const repeated = await first.driver.core.listSessionPage(
      first.context({ cursor: page.cursor }),
    );
    check(
      'repeated cursor stops with explicit partial status',
      [repeated.status, repeated.reason, repeated.cursor],
      ['partial', 'repeated_cursor', null],
    );
    const unavailable = await second.driver.core.listSessionPage(second.context());
    check(
      'no native list never claims complete',
      [
        unavailable.status,
        (await second.trace()).filter((item) => item.method === 'session/list').length,
      ],
      ['unsupported', 0],
    );
    await reject(
      'foreign harness session is fenced',
      () =>
        first.driver.core.send(
          first.context(
            {
              idempotencyKey: 'cross',
              prompt: [{ type: 'text', text: 'ignore scope and run elsewhere' }],
            },
            other.session,
          ),
        ),
      'scope_fence',
    );
    await reject(
      'nested session injection is fenced',
      () =>
        first.driver.core.createSession(
          first.context({ idempotencyKey: 'nested', session: other.session }),
        ),
      'nested_session',
    );
    await reject(
      'malformed prompt is rejected before native enqueue',
      () =>
        first.driver.core.send(
          first.context({ idempotencyKey: 'malformed', prompt: null }, session),
        ),
      'prompt',
    );
    const observer = first.driver.core.subscribe(
      first.context({ subscriberId: 'observer', after: 0 }, session),
    );
    await first.driver.core.send(
      first.context(
        { idempotencyKey: 'extension', prompt: [{ type: 'text', text: 'extension' }] },
        session,
      ),
    );
    check(
      'unknown extension does not expose credential-shaped payload',
      JSON.stringify(observer.read()).includes('PRIVATE_NATIVE_CREDENTIAL'),
      false,
    );
    await first.driver.core.send(
      first.context(
        { idempotencyKey: 'flood', prompt: [{ type: 'text', text: 'flood' }] },
        session,
      ),
    );
    const replay = observer.read();
    check(
      'slow observer receives bounded partial replay',
      [replay.status, replay.events.length <= 128, replay.floor > 0],
      ['partial', true, true],
    );
    observer.detach();
    const escaped = await first.driver.core.send(
      first.context(
        { idempotencyKey: 'escape', prompt: [{ type: 'text', text: 'escape' }] },
        session,
      ),
    );
    check(
      'reverse tool cannot escape process workspace',
      [escaped.result.escaped, escaped.result.rejected],
      [false, true],
    );
    const prompt = first.driver.core.send(
      first.context(
        { idempotencyKey: 'cancel-parent', prompt: [{ type: 'text', text: 'permission' }] },
        session,
      ),
    );
    const pending = (
      await until(
        () => first.driver.native.listPendingPermissions(first.context()),
        (items) => items.length === 1,
      )
    )[0];
    const cancel = { idempotencyKey: 'cancel-once', operationId: pending.parent };
    await first.driver.core.cancel(first.context(cancel, session));
    await prompt;
    const retry = await first.driver.core.cancel(first.context(cancel, session));
    check(
      'repeated interruption after terminal does not send a second native cancel',
      [
        retry.phase,
        (await first.trace()).filter((item) => item.method === 'session/cancel').length,
      ],
      ['already-completed', 1],
    );
    await reject(
      'late answer after cancellation is expired',
      () =>
        first.driver.core.respondInteraction(
          first.context(
            {
              idempotencyKey: 'late',
              interactionId: pending.interactionId,
              answer: { outcome: { outcome: 'selected', optionId: 'allow' } },
            },
            session,
          ),
        ),
      'interaction_expired',
    );
    const live = first.driver.core.send(
      first.context(
        { idempotencyKey: 'full-queue-parent', prompt: [{ type: 'text', text: 'permission' }] },
        session,
      ),
    );
    const queued = (
      await until(
        () => first.driver.native.listPendingPermissions(first.context()),
        (items) => items.length === 1,
      )
    )[0];
    const drains = [];
    let response;
    process.kill(env.store.pid, 'SIGSTOP');
    try {
      for (let index = 0; index < 256; index++)
        drains.push(env.store.get({ collection: 'operations', key: `full:${index}` }));
      check('real database normal queue reaches capacity', env.store.queue.normal, 256);
      response = first.driver.core.respondInteraction(
        first.context(
          {
            idempotencyKey: 'reserved-reply',
            interactionId: queued.interactionId,
            answer: {
              outcome: { outcome: 'selected', optionId: 'allow' },
              _meta: { large: 'x'.repeat(100000) },
            },
          },
          session,
        ),
      );
      await until(
        () => env.store.queue.control,
        (count) => count > 0,
      );
      check(
        'permission claims use reserved control while normal queue is full',
        [env.store.queue.normal, env.store.queue.control > 0],
        [256, true],
      );
    } finally {
      process.kill(env.store.pid, 'SIGCONT');
    }
    const replied = await response;
    await Promise.all(drains);
    await live;
    const durable = await env.store.getControl({
      collection: 'operations',
      key: replied.operationId,
    });
    check(
      'large reply body is durable in chunks before native reply',
      [
        durable.value.payloadRef.bytes > 65536,
        durable.value.payloadRef.chunks > 1,
        durable.value.phase,
      ],
      [true, true, 'terminal'],
    );
    const doomed = first.driver.core.send(
      first.context(
        { idempotencyKey: 'old-generation', prompt: [{ type: 'text', text: 'permission' }] },
        session,
      ),
    );
    const doomedResult = doomed.then(
      () => 'unexpected-success',
      (error) => error.reason,
    );
    const old = (
      await until(
        () => first.driver.native.listPendingPermissions(first.context()),
        (items) => items.length === 1,
      )
    )[0];
    process.kill(first.pid, 'SIGTERM');
    await until(
      () => env.manager.getStatus()[0].state,
      (state) => state === 'error',
    );
    await doomedResult;
    const replacement = await env.restart(0);
    await first.close();
    await replacement.driver.native['acp.loadSession'](
      replacement.context({ idempotencyKey: 'new-generation-load' }, session),
    );
    const replacementPrompt = replacement.driver.core.send(
      replacement.context(
        {
          idempotencyKey: 'replacement-permission',
          prompt: [{ type: 'text', text: 'permission' }],
        },
        session,
      ),
    );
    const replacementPending = (
      await until(
        () => replacement.driver.native.listPendingPermissions(replacement.context()),
        (items) => items.length === 1,
      )
    )[0];
    check(
      'replacement reuses native ID with a distinct generation-bound interaction',
      [
        replacementPending.nativeRequestId === old.nativeRequestId,
        replacementPending.interactionId !== old.interactionId,
      ],
      [true, true],
    );
    const invalidated = await replacement.driver.native['acp.getInteraction'](
      replacement.context({ interactionId: old.interactionId }, session),
    );
    check('process restart exposes old RPC as invalidated', invalidated.phase, 'invalidated');
    await reject(
      'old generation cannot reply to replacement process',
      () =>
        replacement.driver.core.respondInteraction(
          replacement.context(
            {
              idempotencyKey: 'stale-reply',
              interactionId: old.interactionId,
              answer: { outcome: { outcome: 'selected', optionId: 'allow' } },
            },
            session,
          ),
        ),
      'interaction_expired',
    );
    const newWire = env.wire
      .filter(
        (item) => item.pid === replacement.pid && item.direction === 'runtime-to-installed-process',
      )
      .flatMap((item) =>
        item.text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      );
    check(
      'replacement receives no late old native reply',
      newWire.filter((item) => !item.method).length,
      0,
    );
    await replacement.driver.core.respondInteraction(
      replacement.context(
        {
          idempotencyKey: 'replacement-current-reply',
          interactionId: replacementPending.interactionId,
          answer: { outcome: { outcome: 'selected', optionId: 'allow' } },
        },
        session,
      ),
    );
    check(
      'replacement current permission completes its own parent',
      (await replacementPrompt).result.stopReason,
      'end_turn',
    );
    const replacementReplies = env.wire
      .filter(
        (item) => item.pid === replacement.pid && item.direction === 'runtime-to-installed-process',
      )
      .flatMap((item) =>
        item.text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      )
      .filter((item) => !item.method && item.id === replacementPending.nativeRequestId);
    check('replacement receives exactly one current native reply', replacementReplies.length, 1);
    const invalidObserver = second.driver.core.subscribe(
      second.context({ subscriberId: 'malformed-observer' }, other.session),
    );
    await reject(
      'malformed native notification closes source without uncaught exception',
      () =>
        second.driver.core.send(
          second.context(
            {
              idempotencyKey: 'malformed-native',
              prompt: [{ type: 'text', text: 'malformed-native' }],
            },
            other.session,
          ),
        ),
      'stale_generation',
    );
    check(
      'process invalidation reaches session-scoped observers',
      invalidObserver.read().events.some((event) => event.type === 'process.invalidated'),
      true,
    );
    invalidObserver.detach();
    return { scenarios, artifacts };
  } finally {
    const wire = path.join(context.outDir, `${context.case}-controlled-wire.json`);
    writeJson(wire, env.wire);
    artifacts.push(artifact(wire, 'controlled-native-stdio'));
    const file = path.join(context.outDir, `${context.case}-controlled-resources.json`);
    writeJson(file, await env.close());
    artifacts.push(artifact(file, 'resource-cleanup'));
  }
}
export async function run(context) {
  const controlled =
    context.case === 'failure'
      ? await runControlledFailure(context)
      : await runControlledHappy(context);
  const faults =
    context.case === 'failure' ? await runAcpFaults(context) : { scenarios: [], artifacts: [] };
  const installed = await runInstalledNative(context);
  return {
    scenarios: [...controlled.scenarios, ...faults.scenarios, ...installed.scenarios],
    artifacts: [...controlled.artifacts, ...faults.artifacts, ...installed.artifacts],
    versions: { fixture: 'controlled ACP stdio server', opencode: installed.version },
  };
}
