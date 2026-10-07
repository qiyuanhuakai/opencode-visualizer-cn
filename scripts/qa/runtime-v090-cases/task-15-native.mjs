import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { openAcpEnvironment } from './task-15-fixture.mjs';
import { DatabaseSync } from 'node:sqlite';
import { writeJson, artifact } from '../runtime-v090-evidence.mjs';

export async function runInstalledNative(context) {
  const version = execFileSync('opencode', ['--version'], {
    encoding: 'utf8',
    timeout: 15000,
  }).trim();
  assert.equal(version, '1.18.34');
  const model = await localModel();
  const agents = ['installed-opencode-a', 'installed-opencode-b'].map((id) => ({
    id,
    command: 'opencode',
    configure: async ({ home, root, env }) => {
      const isolated = {
        ...env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          plugin: [],
          model: 'qa/mock',
          small_model: 'qa/mock',
          enabled_providers: ['qa'],
          provider: {
            qa: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Owned local QA',
              options: { baseURL: model.endpoint, apiKey: 'local-qa' },
              models: { mock: { name: 'QA', limit: { context: 8192, output: 1024 } } },
            },
          },
          permission: { '*': 'ask' },
        }),
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
      };
      const seed = path.join(home, 'official-session-import.json');
      await writeFile(
        seed,
        JSON.stringify({
          info: {
            id: 'ses_qa_same_task15',
            projectID: 'global',
            directory: root,
            title: 'QA native composite identity',
            version,
            slug: 'qa-same-native-id',
            time: { created: Date.now(), updated: Date.now() },
          },
          messages: [],
        }),
      );
      const imported = execFileSync('opencode', ['import', seed, '--pure'], {
        cwd: root,
        env: { ...process.env, ...isolated },
        encoding: 'utf8',
        timeout: 15000,
      });
      assert(imported.includes('Imported session: ses_qa_same_task15'));
      return { args: ['acp', '--pure', '--cwd', root], env: isolated };
    },
  }));
  let env;
  try {
    env = await openAcpEnvironment({ temporaryRoot: context.temporaryRoot, agents });
  } catch (error) {
    await model.close();
    throw error;
  }

  const artifacts = [],
    scenarios = [];
  const check = (name, observed, expected) => {
    assert.deepEqual(observed, expected, name);
    scenarios.push({ name, assertions: [{ name, observed, expected, passed: true }] });
  };
  try {
    const [driver, other] = env.drivers;
    const session = await driver.driver.core.createSession(
      driver.context({ idempotencyKey: 'installed-create' }),
    );
    check(
      'installed OpenCode ACP initializes and creates native session',
      [driver.capabilities.protocolVersion, session.session.nativeSessionId.startsWith('ses_')],
      [1, true],
    );
    const first = driver.driver.core.subscribe(
      driver.context({ subscriberId: 'actual-window-a' }, session.session),
    );
    const second = driver.driver.core.subscribe(
      driver.context({ subscriberId: 'actual-window-b' }, session.session),
    );
    const initialList = await driver.driver.core.listSessionPage(driver.context());
    const otherList = await other.driver.core.listSessionPage(other.context());
    const seededA = initialList.items.find(
      (item) => item.session.nativeSessionId === 'ses_qa_same_task15',
    );
    const seededB = otherList.items.find(
      (item) => item.session.nativeSessionId === 'ses_qa_same_task15',
    );
    check(
      'installed two private ACP agents preserve same native ID independently',
      [!!seededA, !!seededB, seededA?.key !== seededB?.key, driver.pid !== other.pid],
      [true, true, true, true],
    );
    if (context.case === 'failure') {
      first.detach();
      second.detach();
      await installedFailure(env, driver, session.session, check);
      const file = path.join(context.outDir, 'failure-installed-native-wire.json');
      writeJson(file, { version, wire: env.wire, model: model.requests, scenarios });
      artifacts.push(artifact(file, 'installed-native-acp-failure'));
      return { scenarios, artifacts, version };
    }
    for (let index = 0; index < 100; index++)
      await driver.driver.core.createSession(
        driver.context({ idempotencyKey: `installed-page-${index}` }),
      );
    const list = await driver.driver.core.listSessionPage(driver.context());
    const pages = [list];
    while (pages.at(-1).cursor) {
      assert(pages.length < 10);
      pages.push(
        await driver.driver.core.listSessionPage(driver.context({ cursor: pages.at(-1).cursor })),
      );
    }
    const discovered = pages.flatMap((page) => page.items);
    check(
      'installed OpenCode ACP session/list returns created session',
      discovered.some((item) => item.session.nativeSessionId === session.session.nativeSessionId),
      true,
    );
    const nativeTruth = env.configured.map((config) => {
      const databasePath = execFileSync('opencode', ['db', 'path'], {
        cwd: env.root,
        env: { ...process.env, ...config.env },
        encoding: 'utf8',
        timeout: 15000,
      }).trim();
      assert(databasePath.startsWith(config.env.HOME + path.sep));
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return {
          databasePath,
          sessions: db.prepare('SELECT id, directory, title FROM session').all(),
        };
      } finally {
        db.close();
      }
    });
    writeJson(path.join(context.outDir, `${context.case}-native-paging-diagnostic.json`), {
      nativeTruth,
      pageSizes: pages.map((page) => page.items.length),
      pageStatus: pages.map((page) => page.status),
      discovered: discovered.map((item) => item.session.nativeSessionId),
      missing: nativeTruth[0].sessions.filter(
        (item) => !discovered.some((row) => row.session.nativeSessionId === item.id),
      ),
    });
    check(
      'installed ACP bounded inventory remains partial after final native page',
      [
        nativeTruth[0].sessions.length,
        pages.length > 1,
        new Set(discovered.map((item) => item.session.nativeSessionId)).size,
        pages.at(-1).status,
        pages.at(-1).reason,
        pages.at(-1).cursor,
      ],
      [102, true, 101, 'partial', 'native_session_list_bounded', null],
    );
    check(
      'installed same ID is present in both independent native SQLite stores',
      nativeTruth.map((item) => item.sessions.some((row) => row.id === 'ses_qa_same_task15')),
      [true, true],
    );
    check(
      'installed bounded native profile preserves explicit missing-session evidence',
      nativeTruth[0].sessions
        .filter((item) => !discovered.some((row) => row.session.nativeSessionId === item.id))
        .map((item) => item.id),
      ['ses_qa_same_task15'],
    );
    const loaded = await driver.driver.native['acp.loadSession'](
      driver.context({ idempotencyKey: 'installed-load' }, session.session),
    );
    check(
      'installed OpenCode ACP session/load acknowledges actual session',
      loaded.session.nativeSessionId,
      session.session.nativeSessionId,
    );
    await driver.driver.native['acp.resumeSession'](
      driver.context({ idempotencyKey: 'installed-resume' }, session.session),
    );
    for (const modeId of ['plan', 'build']) {
      await driver.driver.native['acp.setMode'](
        driver.context({ idempotencyKey: `installed-mode-${modeId}`, modeId }, session.session),
      );
      check(
        `installed native mode ${modeId} is reflected from actual config response`,
        driver.driver.native
          .getSessionConfigOptions(driver.context({}, session.session))
          .find((option) => option.category === 'mode').currentValue,
        modeId,
      );
    }
    const fork = await driver.driver.native.forkSession(
      driver.context({ idempotencyKey: 'installed-fork' }, session.session),
    );
    check(
      'installed native fork binds actual new identity',
      [
        fork.session.nativeSessionId !== session.session.nativeSessionId,
        fork.session.harnessInstanceId,
      ],
      [true, session.session.harnessInstanceId],
    );
    await driver.driver.native['acp.closeSession'](
      driver.context({ idempotencyKey: 'installed-fork-close' }, fork.session),
    );
    check(
      'installed native close removes loaded fork state',
      driver.driver.core.getSession(driver.context({}, fork.session)).reason,
      'not_loaded',
    );
    first.detach();
    second.detach();
    const prompt = driver.driver.core.send(
      driver.context(
        {
          idempotencyKey: 'installed-prompt',
          prompt: [
            {
              type: 'text',
              text: `Edit ${env.root}/original.txt from ACP-owned file to ACP edited file.`,
            },
          ],
        },
        session.session,
      ),
    );
    let outcome, failure;
    void prompt.then(
      (value) => {
        outcome = value;
      },
      (error) => {
        failure = error;
      },
    );
    const permissions = [];
    const deadline = Date.now() + 30000;
    while (!outcome && !failure && Date.now() < deadline) {
      const pending = await driver.driver.native.listPendingPermissions(driver.context());
      for (const item of pending) {
        permissions.push(item);
        const reconnect = driver.driver.core.subscribe(
          driver.context({ subscriberId: 'reply-window' }, session.session),
        );
        reconnect.detach();
        const answer = {
          outcome: {
            outcome: 'selected',
            optionId: item.params.options.find((option) => option.kind === 'allow_once').optionId,
          },
        };
        const race = await Promise.allSettled(
          ['a', 'b'].map((window) =>
            driver.driver.core.respondInteraction(
              driver.context(
                {
                  interactionId: item.interactionId,
                  idempotencyKey: `actual-reply-${permissions.length}-${window}`,
                  answer,
                },
                session.session,
              ),
            ),
          ),
        );
        check(
          `installed native permission ${permissions.length} two-window atomic reply`,
          race.map((result) => result.status).sort(),
          ['fulfilled', 'rejected'],
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (failure) throw failure;
    assert(outcome, 'installed prompt did not finish');
    check(
      'installed native permission survives UI absence and executes actual tool',
      [
        permissions.length > 0,
        outcome.result.stopReason,
        (await readFile(path.join(env.root, 'original.txt'), 'utf8')).includes('ACP edited file'),
      ],
      [true, 'end_turn', true],
    );
    const inbound = env.wire
      .filter(
        (item) => item.direction === 'installed-process-to-runtime' && item.pid === driver.pid,
      )
      .map((item) => item.text)
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const reverse = inbound.filter((item) => item.method === 'fs/write_text_file');
    check(
      'installed native edit invokes runtime-owned reverse filesystem in original session',
      reverse.map((item) => [item.params.sessionId, item.params.path]),
      [[session.session.nativeSessionId, path.join(env.root, 'original.txt')]],
    );
    const outbound = env.wire
      .filter(
        (item) => item.direction === 'runtime-to-installed-process' && item.pid === driver.pid,
      )
      .flatMap((item) =>
        item.text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      );
    check(
      'installed OpenCode two observers share exactly one initialize upstream',
      outbound.filter((item) => item.method === 'initialize').length,
      1,
    );
    first.detach();
    second.detach();
    const file = path.join(context.outDir, `${context.case}-installed-native-wire.json`);
    writeJson(file, {
      version,
      argv: env.configured[0].args,
      pid: driver.pid,
      capabilities: driver.capabilities,
      wire: env.wire,
      model: model.requests,
      nativeTruth,
      pageSizes: pages.map((page) => page.items.length),
      permissions,
      scenarios,
    });
    artifacts.push(artifact(file, 'installed-native-acp-stdio'));
    return { scenarios, artifacts, version };
  } finally {
    writeJson(path.join(context.outDir, `${context.case}-installed-wire-even-on-failure.json`), {
      version,
      wire: env.wire,
      model: model.requests,
    });
    const file = path.join(context.outDir, `${context.case}-installed-native-cleanup.json`);
    writeJson(file, await env.close());
    await model.close();
    artifacts.push(artifact(file, 'resource-cleanup'));
  }
}

async function installedFailure(env, driver, session, check) {
  async function pending() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const items = await driver.driver.native.listPendingPermissions(driver.context());
      if (items.length) return items[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Installed native permission did not arrive');
  }
  const prompt = (key) =>
    driver.driver.core.send(
      driver.context(
        {
          idempotencyKey: key,
          prompt: [
            {
              type: 'text',
              text: `Edit ${env.root}/original.txt from ACP-owned file to ACP edited file.`,
            },
          ],
        },
        session,
      ),
    );
  const first = prompt('actual-cancel-parent');
  const permission = await pending();
  const cancel = { operationId: permission.parent, idempotencyKey: 'actual-cancel' };
  await driver.driver.core.cancel(driver.context(cancel, session));
  const cancelled = await first;
  const duplicate = await driver.driver.core.cancel(driver.context(cancel, session));
  check(
    'failure installed cancellation is terminal and duplicate does not resend',
    [cancelled.result.stopReason, duplicate.phase],
    ['cancelled', 'already-completed'],
  );
  check(
    'failure installed denied tool has no filesystem side effect',
    await readFile(path.join(env.root, 'original.txt'), 'utf8'),
    'ACP-owned file\n',
  );
  const second = prompt('actual-restart-parent');
  const lost = second.then(
    () => 'unexpected-success',
    (error) => error.reason,
  );
  const old = await pending();
  process.kill(driver.pid, 'SIGTERM');
  await lost;
  const replacement = await env.restart(0);
  await driver.close();
  await replacement.driver.native['acp.loadSession'](
    replacement.context({ idempotencyKey: 'actual-restart-load' }, session),
  );
  const invalidated = await replacement.driver.native['acp.getInteraction'](
    replacement.context({ interactionId: old.interactionId }, session),
  );
  check(
    'failure installed process restart explicitly invalidates unrecoverable native RPC',
    invalidated.phase,
    'invalidated',
  );
  let rejected;
  try {
    await replacement.driver.core.respondInteraction(
      replacement.context(
        {
          idempotencyKey: 'actual-late',
          interactionId: old.interactionId,
          answer: { outcome: { outcome: 'selected', optionId: old.params.options[0].optionId } },
        },
        session,
      ),
    );
  } catch (error) {
    rejected = error.reason;
  }
  check(
    'failure installed old request cannot reply to replacement',
    rejected,
    'interaction_expired',
  );
  const outbound = env.wire
    .filter((item) => item.direction === 'runtime-to-installed-process')
    .flatMap((item) =>
      item.text
        .trim()
        .split('\n')
        .map((line) => ({ pid: item.pid, message: JSON.parse(line) })),
    );
  check(
    'failure installed native wire proves single cancellation and no late reply',
    [
      outbound.filter((item) => item.message.method === 'session/cancel').length,
      outbound.filter((item) => item.pid === replacement.pid && !item.message.method).length,
    ],
    [1, 0],
  );
}

async function localModel() {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      requests.push({ url: request.url, input });
      if (requests.length > 20) throw new Error('Unexpected native model loop');
      const tools = input.tools ?? [];
      let tool;
      const turn = input.messages.slice(
        input.messages.findLastIndex((message) => message.role === 'user'),
      );
      const hasRead = turn.some((message) => message.role === 'tool');
      const hasEdit = turn.some(
        (message) =>
          message.role === 'assistant' &&
          message.tool_calls?.some((call) => call.function.name === 'edit'),
      );
      const prompt = turn[0];
      const match = JSON.stringify(prompt).match(/(\/[^ "\\]+\/original\.txt)/);
      if (tools.length && match && !hasEdit)
        tool = hasRead
          ? {
              name: 'edit',
              arguments: JSON.stringify({
                filePath: match[1],
                oldString: 'ACP-owned file',
                newString: 'ACP edited file',
              }),
            }
          : { name: 'read', arguments: JSON.stringify({ filePath: match[1] }) };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: 'qa-local', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (tool) {
        chunk({
          role: 'assistant',
          tool_calls: [
            { index: 0, id: `call-${requests.length}`, type: 'function', function: tool },
          ],
        });
        chunk({}, 'tool_calls');
      } else {
        chunk({ role: 'assistant', content: 'Local ACP QA completed.' });
        chunk({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    requests,
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
