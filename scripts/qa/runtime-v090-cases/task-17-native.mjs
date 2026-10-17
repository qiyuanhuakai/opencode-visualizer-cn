import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createDshAuthProvider } from '../../../bridge/dshAuth.js';
import { createDshTransport } from '../../../bridge/runtime/drivers/dshTransport.js';

export const nativeRoot = '/home/qiyuaner/.nvm/versions/node/v24.14.1/lib/node_modules/@deepseek-ai/dsh';
const installed = (name) => path.join(nativeRoot, 'node_modules/@deepseek-ai', name, 'lib/index.js');
export async function createInstalledGateway(register) {
  const source = installed('dsh-api-gateway'), bytes = await readFile(source);
  const version = JSON.parse(await readFile(path.join(nativeRoot, 'node_modules/@deepseek-ai/dsh-api-gateway/package.json'), 'utf8')).version;
  const identity = { kind: 'installed-gateway-private-source-seam', source, version, sha256: createHash('sha256').update(bytes).digest('hex') };
  register({ kind: 'Cordis context and gateway remote event source', identity, teardown: 'removeSource(); ctx.fiber.dispose()' });
  const [{ Context }, { TypertGatewayService }] = await Promise.all([import(pathToFileURL(installed('cordis')).href), import(pathToFileURL(source).href)]);
  const ctx = new Context(), gateway = new TypertGatewayService(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
  const queue = []; let wake, stopped = false;
  async function* sourceEvents(signal) {
    const abort = () => { stopped = true; wake?.(); };
    signal.addEventListener('abort', abort, { once: true });
    try { while (!stopped) { if (!queue.length) await new Promise((resolve) => { wake = resolve; }); if (stopped) return; while (queue.length) yield queue.shift(); } }
    finally { signal.removeEventListener('abort', abort); }
  }
  const removeSource = gateway.registerRemoteEvents(sourceEvents, { home: '/private-dsh-qa' });
  function enqueue(value) { queue.push(value); wake?.(); wake = undefined; }
  return { identity, gateway,
    emit(event, args) { enqueue({ event, args }); },
    waterfall(event = 'approval/request', agentId = 'native-1', request = { toolName: 'bash', arguments: { command: 'true' } }) {
      const agent = { id: agentId }, controller = new AbortController();
      let resolve, reject;
      const outcome = new Promise((yes, no) => { resolve = yes; reject = no; }).then(
        (value) => ({ status: 'resolved', value }), (error) => ({ status: 'rejected', name: error.name, message: error.message }));
      enqueue({ event, context: { agentId, subject: agent, value: ctx }, request: { ...request, agent, signal: controller.signal }, resolve, reject });
      return { outcome, cancel: () => controller.abort(new Error('private-source-cancelled')) };
    },
    snapshot() { return { pending: [...gateway.pendingRemoteEvents.keys()], clients: [...gateway.remoteEventClients.keys()],
      deliveries: [...gateway.pendingRemoteEvents.values()].map((value) => ({ eventId: value.id, clients: [...value.deliveries].map((client) => client.id) })) }; },
    async close() { await removeSource(); await ctx.fiber.dispose(); assert.equal(gateway.pendingRemoteEvents.size, 0); assert.equal(gateway.remoteEventClients.size, 0); },
  };
}
export async function assertPortReleased(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
}
export async function startNativeDsh({ root, register, log, port = 0, expectFailure = false }) {
  const ownedRoot = path.join(root, `native-${randomUUID()}`), profile = path.join(ownedRoot, 'dsh-home'), workspace = path.join(ownedRoot, 'workspace');
  register({ kind: 'installed-dsh-private-profile', ownedRoot, profile, workspace, requestedPort: port, teardown: 'kill owned process group; await exit; exclusive port rebind; rm ownedRoot' });
  await mkdir(workspace, { recursive: true });
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: ownedRoot, DSH_HOME: profile,
    XDG_CONFIG_HOME: path.join(ownedRoot, 'config'), XDG_DATA_HOME: path.join(ownedRoot, 'data'), XDG_CACHE_HOME: path.join(ownedRoot, 'cache') };
  register({ kind: 'private-cli-version-probe', command: [process.execPath, path.join(nativeRoot, 'lib/bin.js'), '--version'], teardown: 'synchronous process exit with10000ms deadline' });
  const nativeVersion = execFileSync(process.execPath, [path.join(nativeRoot, 'lib/bin.js'), '--version'], { cwd: workspace, env, timeout: 10000, encoding: 'utf8' }).trim();
  log({ kind: 'native-version', nativeVersion });
  assert.equal(nativeVersion, '0.2.0-rc.2');
  const command = [process.execPath, path.join(nativeRoot, 'lib/bin.js'), 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'];
  const child = spawn(command[0], command.slice(1), { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  register({ kind: 'native-child', pid: child.pid, command, cwd: workspace, environmentPolicy: 'allowlist only; no inherited API credentials', teardown: 'SIGTERM owned process group, then SIGKILL only on deadline; await exit' });
  let output = '', launchToken, origin, generation = 1;
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  const append = (chunk) => { output = (output + chunk.toString()).slice(-65536); };
  child.stderr.on('data', append);
  let startupTimer;
  const started = new Promise((resolve, reject) => {
    startupTimer = setTimeout(() => reject(new Error('native-startup-deadline')), 30000);
    child.stdout.on('data', (chunk) => {
      append(chunk);
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s]+)/.exec(output.split(String.fromCharCode(27)).join(' '));
      if (match) { origin = `http://127.0.0.1:${match[1]}`; launchToken = match[2]; clearTimeout(startupTimer); resolve(); }
    });
    child.once('error', reject);
    exited.then((exit) => { clearTimeout(startupTimer); reject(new Error(`native-exit:${exit.code}:${exit.signal}`)); });
  });
  const close = async () => {
    clearTimeout(startupTimer);
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 8000);
    const exit = await exited; clearTimeout(killTimer);
    const nativePort = origin ? Number(new URL(origin).port) : null;
    if (nativePort !== null) await assertPortReleased(nativePort);
    const sanitized = output.split(String.fromCharCode(27)).join(' ').replace(/token=[^\s]+/g, 'token=[REDACTED]');
    log({ kind: 'native-exit', pid: child.pid, port: nativePort, exit, output: sanitized });
    await rm(ownedRoot, { recursive: true, force: true });
    return { pid: child.pid, exit, port: nativePort, portReleased: nativePort !== null, rootRemoved: ownedRoot };
  };
  try { await started; }
  catch (error) { const receipt = await close(); if (expectFailure) return { failed: true, reason: error.message, receipt }; throw error; }
  register({ kind: 'native-listener', port: Number(new URL(origin).port), teardown: 'owned child exit + exclusive rebind' });
  const auth = createDshAuthProvider({ getLaunchToken: () => launchToken });
  const getOwnedEndpoint = () => ({ state: 'ready', ownership: 'owned', nativeVersion, origin, generation });
  const transport = createDshTransport({ getOwnedEndpoint, auth });
  return { failed: false, origin, auth, transport, workspace, profile, pid: child.pid, getOwnedEndpoint,
    rotateGeneration() { generation++; auth.invalidate(new URL(origin).host); },
    async close() { transport.close(); return close(); },
  };
}
