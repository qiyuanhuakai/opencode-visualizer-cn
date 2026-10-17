import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createKimiWebTokenProvider } from '../../../bridge/kimiWebToken.js';
import { createKimiWebTransport } from '../../../bridge/runtime/drivers/kimiWebTransport.js';

export async function until(predicate, label, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve)); return port;
}
async function released(port) {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise((resolve) => server.close(resolve)); return true;
}
export async function startNativeKimi({ temporaryRoot, recordResource }) {
  const binary = path.join(homedir(), '.kimi-code/bin/kimi');
  const binaryBytes = await readFile(binary);
  const binaryHash = createHash('sha256').update(binaryBytes).digest('hex');
  const resolver = binaryBytes.indexOf('function getDataDir()');
  assert(resolver > 0, 'installed CLI resolver is inspectable before spawn');
  const resolverText = binaryBytes.subarray(resolver, resolver + 260).toString('utf8');
  assert(resolverText.includes('process.env[KIMI_CODE_HOME_ENV]') && resolverText.includes('if (envDir) return envDir'), 'installed private state override verified');
  assert(binaryBytes.includes(Buffer.from('KIMI_CODE_HOME_ENV = "KIMI_CODE_HOME"')), 'override name verified from installed CLI');
  await recordResource({ type: 'private-native-home', phase: 'planned', pattern: path.join(temporaryRoot, 'kimi-native-'), teardown: 'remove only created private directory' });
  const root = await mkdtemp(path.join(temporaryRoot, 'kimi-native-'));
  await recordResource({ type: 'private-native-home', phase: 'created', root });
  const data = path.join(root, 'data'), workspace = path.join(root, 'workspace');
  await mkdir(data); await mkdir(workspace);
  await writeFile(path.join(data, 'config.toml'), 'telemetry = false\nauto_session_title = false\nmerge_all_available_skills = false\n');
  const env = { PATH: process.env.PATH, HOME: root, KIMI_CODE_HOME: data, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'xdg'), TERM: 'dumb' };
  const version = spawnSync(binary, ['--version'], { env, cwd: workspace, encoding: 'utf8', timeout: 15000 });
  assert.equal(version.status, 0); assert.match(version.stdout, /2\.1\.1/u, 'actual compatibility profile');
  const listing = spawnSync(binary, ['session', 'list', '--all', '--json'], { env, cwd: workspace, encoding: 'utf8', timeout: 15000 });
  assert.equal(listing.status, 0); assert.deepEqual(JSON.parse(listing.stdout), [], 'private native CLI inventory starts empty');
  const provider = createKimiWebTokenProvider({ tokenPath: path.join(data, 'server.token') });
  const port = await freePort();
  let child, childExit, model, modelPort, modelAlias, stopped = true;
  const responses = new Set(), modelSockets = new Set();
  const modelCalls = [], processReceipts = [];
  async function start() {
    await recordResource({ type: 'native-process', phase: 'planned', binary, port, privateRoot: root, arguments: ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port)] });
    child = spawn(binary, ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { env, cwd: workspace, stdio: 'ignore' });
    childExit = once(child, 'exit'); stopped = false;
    await recordResource({ type: 'native-process', phase: 'created', pid: child.pid, port });
    await until(async () => {
      if (child.exitCode !== null) throw new Error('isolated native process exited before readiness');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/meta`, { headers: { Authorization: provider.getAuthorization() }, signal: AbortSignal.timeout(300) });
        return response.ok;
      } catch (error) { if (!(error instanceof Error)) throw error; return false; }
    }, 'native ready');
  }
  async function stop() {
    if (stopped) return;
    stopped = true; child.kill('SIGTERM');
    const receipt = await Promise.race([childExit, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('native shutdown timeout')), 15000); timer.unref();
    })]);
    assert.equal(receipt[0], 0, 'native clean shutdown');
    assert.equal(await released(port), true);
    let alive = true;
    try { process.kill(child.pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
    assert.equal(alive, false);
    const value = { pid: child.pid, code: receipt[0], signal: receipt[1], exclusiveRebind: true };
    processReceipts.push(value); await recordResource({ type: 'native-process', phase: 'cleaned', ...value });
  }
  const transport = createKimiWebTransport({ endpoint: `http://127.0.0.1:${port}`, getAuthorization: provider.getAuthorization });
  try { await start(); }
  catch (error) { await stop(); await transport.close(); await rm(root, { recursive: true, force: true }); throw error; }
  async function configureLocalModel({ questionFirst = false } = {}) {
    await recordResource({ type: 'local-model-http', phase: 'planned', host: '127.0.0.1', port: 0, model: 'controlled SSE stream, never paid inference' });
    model = createHttpServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        modelCalls.push({ method: req.method, path: req.url, stream: request.stream, model: request.model, tools: request.tools?.map((tool) => tool.function?.name) ?? [] });
        assert.equal(req.url, '/v1/chat/completions');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (questionFirst && modelCalls.filter((entry) => entry.method).length === 1) {
          const argumentsJson = JSON.stringify({ questions: [{ question: 'Choose the private native QA option', header: 'QA', options: [{ label: 'First', description: 'Continue QA' }, { label: 'Second', description: 'Alternative QA' }] }] });
          res.write(`data: ${JSON.stringify({ id: 'private-native-question', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'private-question-call', type: 'function', function: { name: 'AskUserQuestion', arguments: argumentsJson } }] }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'private-native-question', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.write(`data: ${JSON.stringify({ id: 'private-model-response', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta: { role: 'assistant', content: 'task16 native selected transcript' }, finish_reason: null }] })}\n\n`);
        responses.add(res);
        res.on('close', () => { responses.delete(res); modelCalls.push({ closed: true }); });
      });
    });
    model.on('connection', (socket) => { modelSockets.add(socket); socket.on('close', () => modelSockets.delete(socket)); });
    await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve)); modelPort = model.address().port;
    await recordResource({ type: 'local-model-http', phase: 'created', port: modelPort });
    await transport.request('POST', '/api/v1/providers', { id: 'task16', type: 'openai', base_url: `http://127.0.0.1:${modelPort}/v1`, api_key: 'private-local-fixture', models: [{ model: 'local-test', max_context_size: 32000 }] });
    const models = await transport.request('GET', '/api/v1/models');
    modelAlias = models.items.find((item) => item.provider === 'task16')?.model;
    assert.equal(modelAlias, 'task16/local-test');
    await transport.request('POST', '/api/v1/config', { default_model: modelAlias, telemetry: false, auto_session_title: false, merge_all_available_skills: false });
    return modelAlias;
  }
  return {
    root, data, workspace, endpoint: `http://127.0.0.1:${port}`, getAuthorization: provider.getAuthorization, transport,
    version: version.stdout.trim(), binaryHash, resolverHash: createHash('sha256').update(resolverText).digest('hex'), processReceipts, modelCalls,
    get heldModelResponses() { return responses.size; }, configureLocalModel,
    async rotateToken() {
      const before = provider.getAuthorization();
      const rotated = spawnSync(binary, ['web', 'rotate-token'], { env, cwd: workspace, stdio: 'ignore', timeout: 15000 });
      assert.equal(rotated.status, 0);
      const after = provider.getAuthorization(); assert.notEqual(after, before);
      const stale = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, { headers: { Authorization: before } });
      await stale.arrayBuffer(); assert.equal(stale.status, 401);
      assert.equal((await transport.request('GET', '/api/v1/meta')).server_version, '2.1.1');
      return { rotateExit: rotated.status, changed: true, oldStatus: stale.status, rereadStatus: 200 };
    },
    async restart() { await stop(); await start(); }, stop,
    async close() {
      await transport.close(); await stop();
      if (model) {
        for (const response of responses) response.end();
        for (const socket of modelSockets) socket.destroy();
        await new Promise((resolve) => model.close(resolve));
        assert.equal(await released(modelPort), true);
        await recordResource({ type: 'local-model-http', phase: 'cleaned', port: modelPort, exclusiveRebind: true, sockets: modelSockets.size });
      }
      await rm(root, { recursive: true, force: true });
      await recordResource({ type: 'private-native-home', phase: 'cleaned', root, deleted: true });
      return { processReceipts, privateHomeDeleted: true, modelPortReleased: model ? true : null };
    },
  };
}
