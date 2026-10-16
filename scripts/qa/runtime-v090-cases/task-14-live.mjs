import { startupCancellation } from './task-14-instance.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexHistory } from '../../../bridge/runtime/drivers/codexHistory.js';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCodexProcess } from '../../../bridge/runtime/drivers/codexProcess.js';
import { createAppServerClient } from '../../../shared/runtime/native/codex/appServerClient.js';
import { createCodexDiscovery } from '../../../shared/runtime/native/codex/discovery.js';
import { artifact, writeJson } from '../runtime-v090-evidence.mjs';
export async function live(context) {
  const home = await mkdtemp(path.join(context.temporaryRoot, 'native-'));
  const root = path.join(home, 'repo');
  await mkdir(root);
  const sockets = new Set();
  let heldRequest = false;
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    let body = '';
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, value) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    const message = {
      id: 'msg_qa',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'native model reply', annotations: [] }],
    };
    event('response.created', {
      response: { id: 'resp_qa', object: 'response', status: 'in_progress', output: [] },
    });
    if (body.includes('native hold')) {
      heldRequest = true;
      return;
    }
    event('response.output_item.added', {
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    });
    event('response.output_text.delta', {
      item_id: 'msg_qa',
      output_index: 0,
      content_index: 0,
      delta: 'native model reply',
    });
    event('response.output_item.done', { output_index: 0, item: message });
    event('response.completed', {
      response: {
        id: 'resp_qa',
        object: 'response',
        status: 'completed',
        output: [message],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      },
    });
    response.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await writeFile(
    path.join(home, 'config.toml'),
    `model_provider = "custom"\nmodel = "gpt-5.4"\n[model_providers.custom]\nname = "QA custom"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
  );
  const expected = [];
  for (let i = 0; i < 65; i++) {
    const id = `a1111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
    const archived = i >= 58;
    const directory = path.join(home, archived ? 'archived_sessions' : 'sessions/2025/01/01');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `rollout-2025-01-01T00-00-00-${id}.jsonl`);
    const timestamp = '2025-01-01T00:00:00.000Z';
    const records = [
      {
        timestamp,
        type: 'session_meta',
        payload: {
          id,
          timestamp,
          cwd: root,
          originator: 'codex_cli_rs',
          cli_version: '0.160.0',
          source: i % 5 ? 'cli' : 'exec',
          model_provider: i % 3 ? 'openai' : 'custom',
        },
      },
      {
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `native inventory ${i}` }],
        },
      },
      {
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: `native inventory ${i}`,
          images: [],
          local_images: [],
        },
      },
    ];
    await writeFile(file, records.map((v) => JSON.stringify(v)).join('\n') + '\n');
    expected.push({ id, archived, provider: records[0].payload.model_provider, file });
  }
  const wire = [];
  const transport = createCodexProcess({ cwd: root, env: { ...process.env, CODEX_HOME: home } });
  const originalSend = transport.send;
  transport.send = (raw) => {
    wire.push({ direction: 'client', message: JSON.parse(raw) });
    originalSend(raw);
  };
  const unsub = transport.subscribe(
    (raw) => wire.push({ direction: 'native', message: JSON.parse(raw) }),
    () => {},
  );
  const client = createAppServerClient({ transport, onMessage() {}, onFailure() {} });
  const scenarios = [];
  try {
    await client.request('initialize', {
      clientInfo: { name: 'vis_native_qa', version: '0.9.0' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized', {});
    const list = createCodexDiscovery({
      request: (m, p) => client.request(m, p),
      generation: 1,
      summary: async (thread, archived) => ({
        session: { nativeSessionId: thread.id },
        archived,
        provider: thread.modelProvider,
      }),
    });
    let cursor = null;
    const actual = [];
    let page;
    do {
      page = await list({ limit: 13, cursor });
      actual.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    const observed = actual.map((v) => [v.session.nativeSessionId, v.archived, v.provider]).sort();
    const wanted = expected.map((v) => [v.id, v.archived, v.provider]).sort();
    const evidence = path.join(context.outDir, `live-inventory-${context.case}.json`);
    writeJson(evidence, {
      binary: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
      expected,
      observed,
      page,
      wire,
    });
    assert.deepEqual(
      observed,
      wanted,
      'installed native binary exhausts independent rollout inventory',
    );
    assert.equal(page.completeness, 'complete');
    scenarios.push({
      name: 'installed Codex enumerates 65 initially unindexed old rollouts across providers and archives',
      assertions: [{ name: 'native inventory equality', observed, expected: wanted, passed: true }],
    });
    const created = await client.request('thread/start', {
      cwd: root,
      model: 'gpt-5.4',
      modelProvider: 'custom',
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    const started = await client.request('turn/start', {
      threadId: created.thread.id,
      input: [{ type: 'text', text: 'native hello' }],
    });
    const waitTerminal = async (id) => {
      const deadline = Date.now() + 15000;
      for (;;) {
        const entry = wire.find(
          (v) =>
            v.direction === 'native' &&
            v.message.method === 'turn/completed' &&
            v.message.params.turn.id === id,
        );
        if (entry) return entry.message.params.turn;
        assert(Date.now() < deadline, 'native terminal deadline');
        await delay(10);
      }
    };
    const completed = await waitTerminal(started.turn.id);
    assert.equal(completed.status, 'completed');
    const history = createCodexHistory({
      request: (m, p) => client.request(m, p),
      processGeneration: 1,
      epoch: 'live',
      assertCurrent() {},
    });
    const pages = [];
    cursor = null;
    do {
      const historyPage = await history({
        session: {
          environmentId: '11111111-1111-4111-8111-111111111111',
          harnessInstanceId: '22222222-2222-4222-8222-222222222222',
          nativeSessionId: created.thread.id,
        },
        cursor,
      });
      pages.push(historyPage);
      cursor = historyPage.cursor;
    } while (cursor);
    assert(
      pages.some((v) => v.items.some((item) => item.native.text === 'native model reply')),
      'native history readback retains actual model reply',
    );
    const held = await client.request('turn/start', {
      threadId: created.thread.id,
      input: [{ type: 'text', text: 'native hold' }],
    });
    const holdDeadline = Date.now() + 15000;
    while (!heldRequest) {
      assert(Date.now() < holdDeadline, 'held model request deadline');
      await delay(10);
    }
    await client.request('turn/interrupt', { threadId: created.thread.id, turnId: held.turn.id });
    const interrupted = await waitTerminal(held.turn.id);
    assert.equal(interrupted.status, 'interrupted');
    const runtimeEvidence = path.join(context.outDir, `live-turn-${context.case}.json`);
    writeJson(runtimeEvidence, { completed, interrupted, pages, wire });
    scenarios.push({
      name: 'installed native create send paged history and cancel use isolated local model protocol',
      assertions: [
        {
          name: 'native turn outcomes and retained response',
          observed: [completed.status, interrupted.status, true],
          expected: ['completed', 'interrupted', true],
          passed: true,
        },
      ],
    });
    client.close();
    await transport.close();
    await transport.exited;
    requests = 0;
    const startup = await startupCancellation({
      context,
      root,
      home,
      modelStarted: () => requests > 0,
    });
    return {
      scenarios: [...scenarios, ...startup.scenarios],
      artifacts: [
        artifact(evidence, 'real-native-inventory'),
        artifact(runtimeEvidence, 'real-native-turns'),
        ...startup.artifacts,
      ],
    };
  } finally {
    writeJson(path.join(context.outDir, `live-wire-${context.case}.json`), wire);
    unsub();
    client.close();
    await transport.close();
    await transport.exited;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
}
