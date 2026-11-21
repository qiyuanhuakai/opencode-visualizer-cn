import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridgeRuntime } from '../../bridge/bridgeRuntime.js';
import { createVisBridgeServer } from '../../vis_bridge.js';
import { createBridgeConfigStore } from '../../bridge/bridgeConfig.js';
import { createAcpProcessManager } from '../../bridge/acpProcessManager.js';
import { createOpenCodeDriver } from '../../bridge/runtime/drivers/openCodeDriver.js';
import { createCodexDriver } from '../../bridge/runtime/drivers/codexDriver.js';
import { createKimiWebDriver } from '../../bridge/runtime/drivers/kimiWebDriver.js';
import { createDshDriver } from '../../bridge/runtime/drivers/dshDriver.js';

const root = path.resolve(process.argv[2]);
const stateRoot = path.resolve(process.argv[3]);
const empty = process.argv.includes('--empty');
const native = JSON.parse(await readFile(path.join(root, 'native.json'), 'utf8'));
const environmentId = '09000000-0000-4000-8000-000000000090';
const stdio = fileURLToPath(new URL('./runtime-v090-perf-stdio.mjs', import.meta.url));
await mkdir(stateRoot, { recursive: true });
const env = { VIS_PERF_ROOT: root, VIS_PERF_COUNT: String(native.count) };
const config = { version: 1, nativeServices: { opencode: !empty, codex: !empty, 'kimi-web': !empty, dsh: !empty }, acpAgents: empty ? [] : [{ id: 'seed090', name: 'Seed090 ACP protocol peer', enabled: true, command: process.execPath, args: [stdio, 'acp'], env }] };
const configPath = path.join(stateRoot, 'bridge.json');
await writeFile(configPath, JSON.stringify(config));
const nativeSupervisor = { start: async () => [], stop: async () => {}, getStatus: () => [] };
const acpManager = createAcpProcessManager();
const roots = Array.from({ length: 200 }, (_, index) => ({ root: path.join(root, 'worktrees', `wt-${index}`), permissions: ['read', 'write', 'command', 'pty', 'reverse'] }));
const traceOrigin = performance.now();
const traceFactory = (kind, factory) => async context => {
  process.send?.({ type: 'factory-start', kind, elapsedMs: performance.now() - traceOrigin });
  const result = await factory(context);
  process.send?.({ type: 'factory-ready', kind, elapsedMs: performance.now() - traceOrigin });
  if (process.env.VIS_PERF_TRACE === '1') {
    const firstRow = async () => {
      if (performance.now() - traceOrigin > 30000) return;
      const page = await context.store.page({ collection: 'session_summaries', limit: 1 });
      if (page.items.length) process.send?.({ type: 'first-persisted-session', kind, elapsedMs: performance.now() - traceOrigin });
      else setTimeout(() => { void firstRow().catch(() => {}); }, 100).unref();
    };
    void firstRow().catch(() => {});
    const registration = result.registration ?? { manifest: result.manifest, driver: result.driver };
    const traced = { ...registration, driver: { ...registration.driver, core: { ...registration.driver.core,
      listSessionPage: async input => {
        const page = await registration.driver.core.listSessionPage(input);
        process.send?.({ type: 'native-page', kind, count: page.items?.length, elapsedMs: performance.now() - traceOrigin });
        return page;
      },
    } } };
    return result.registration ? { ...result, registration: traced } : { ...result, ...traced };
  }
  return result;
};
const runtime = createBridgeRuntime({
  environmentId, stateRoot, configStore: createBridgeConfigStore({ configPath }), localWorkspaceRoots: roots,
  nativeSupervisor, acpManager,
  runtimeDriverFactories: {
    opencode: traceFactory('opencode', (context) => createOpenCodeDriver({ ...context, processGeneration: 1, currentProcess: context.authority, endpoint: native.opencode, officialStorePath: native.databasePath })),
    codex: traceFactory('codex', (context) => createCodexDriver({
      ...context, processGeneration: 1, isProcessCurrent: () => true,
      process: { executable: process.execPath, args: [stdio, 'codex'], cwd: roots[0].root, env: { ...process.env, ...env } },
      authorizeDirectory: async (directory) => {
        const canonical = await realpath(directory);
        const grant = context.workspace.workspaces.find((entry) => entry.root === canonical);
        if (!grant) throw new Error(`Ungrantable seed090 native directory ${canonical}`);
        return { environmentId, canonicalPath: canonical, pathPolicy: grant.pathPolicy };
      },
      allowedWorkspaces: context.workspace.workspaces.map((entry) => entry.key),
    })),
    'kimi-web': traceFactory('kimi-web', (context) => createKimiWebDriver({ ...context, endpoint: native.kimi, ownership: 'borrowed', getAuthorization: async () => 'Bearer fixture-token-one', getAuthority: context.authority })),
    dsh: traceFactory('dsh', (context) => createDshDriver({
      ...context, auth: { getCookie: async () => 'private-fixture-cookie', invalidate() {} },
      getOwnedEndpoint: () => ({ state: 'ready', ownership: 'owned', nativeVersion: '0.2.2-rc.5', origin: native.dsh, generation: 1 }),
    })),
  },
});
const server = createVisBridgeServer({ host: '127.0.0.1', path: '/codex', target: 'ws://127.0.0.1:1', runtime });
await new Promise((resolve) => server.listen(Number(process.env.VIS_QA_BRIDGE_PORT ?? 0), '127.0.0.1', resolve));
const booted = performance.now();
const host = await runtime.getRuntimeHost();
const descriptor = { pid: process.pid, port: server.address().port, environmentId, stateRoot, empty };
process.send?.({ type: 'ready', ...descriptor });
console.log(JSON.stringify(descriptor));
void host.sourcesReady.then(() => {
  const result = { type: 'indexed', elapsedMs: performance.now() - booted, inspection: host.inspect(), failures: host.startupFailures.map((error) => String(error)) };
  process.send?.(result);
  console.log(JSON.stringify(result));
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await runtime.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  process.send?.({ type: 'closed' });
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void close().catch((error) => { console.error(error); process.exit(1); }));
