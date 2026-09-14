#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const QA_HOST = '127.0.0.1';
const QA_PORT = 5178;
const DEFAULT_QA_URL = `http://${QA_HOST}:${QA_PORT}`;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function serveQaApp() {
  const [{ createServer: createViteServer }, { default: vue }] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-vue'),
  ]);
  const server = await createViteServer({
    configFile: false,
    base: './',
    root: path.join(repositoryRoot, 'app'),
    plugins: [vue()],
    resolve: {
      alias: {
        buffer: 'buffer/',
        fs: path.join(repositoryRoot, 'app/utils/node-polyfill.ts'),
        path: path.join(repositoryRoot, 'app/utils/node-polyfill.ts'),
        crypto: path.join(repositoryRoot, 'app/utils/node-polyfill.ts'),
      },
    },
    server: { host: QA_HOST, port: QA_PORT, strictPort: true },
    worker: { format: 'es' },
    define: { __GIT_REVISION__: JSON.stringify('browser-qa') },
  });
  await server.listen();
  server.printUrls();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

if (process.argv[2] === '--serve-qa') await serveQaApp();

function errorText(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function reservePort() {
  const server = createServer();
  server.unref();
  try {
    server.listen({ host: QA_HOST, port: QA_PORT, exclusive: true });
    await once(server, 'listening');
  } catch (error) {
    server.close();
    if (error?.code === 'EADDRINUSE') {
      throw new Error(`Task browser QA requires exclusive ownership of ${QA_HOST}:${QA_PORT}; the port is already occupied.`);
    }
    throw error;
  }
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function waitForVite(baseUrl, processState) {
  const deadline = Date.now() + 30_000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (processState.exit) {
      throw new Error(`Vite exited before becoming ready (${processState.exit.code ?? processState.exit.signal}).`);
    }
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = errorText(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not become ready at ${baseUrl}: ${lastError}`);
}

async function stopProcessGroup(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (graceful) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await exited;
}

function validateQaUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || url.hostname !== QA_HOST || Number(url.port) !== QA_PORT) {
    throw new Error(`VIS_QA_URL must be ${DEFAULT_QA_URL}; received ${rawUrl}.`);
  }
  return url.origin;
}

export async function runBrowserQa(options, scenario) {
  const baseUrl = validateQaUrl(process.env.VIS_QA_URL || DEFAULT_QA_URL);
  const evidenceDir = path.resolve(repositoryRoot, options.evidenceDir);
  const consoleEntries = [];
  const pageErrors = [];
  const requestFailures = [];
  const viteOutput = [];
  const lifecycle = {
    scenario: options.name,
    baseUrl,
    host: QA_HOST,
    port: QA_PORT,
    startedAt: new Date().toISOString(),
    portExclusiveBeforeStart: false,
    vitePid: null,
    browserClosed: false,
    contextClosed: false,
    pageClosed: false,
    viteStopped: false,
    portReleased: false,
    result: 'failed',
  };
  let viteProcess;
  let browser;
  let context;
  let page;
  let scenarioError;

  await mkdir(evidenceDir, { recursive: true });
  try {
    await reservePort();
    lifecycle.portExclusiveBeforeStart = true;
    viteProcess = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve-qa'], {
      cwd: repositoryRoot,
      detached: true,
      env: { ...process.env, BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    lifecycle.vitePid = viteProcess.pid;
    const processState = { exit: null };
    viteProcess.on('exit', (code, signal) => {
      processState.exit = { code, signal };
    });
    for (const [streamName, stream] of [['stdout', viteProcess.stdout], ['stderr', viteProcess.stderr]]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => viteOutput.push({ stream: streamName, chunk, time: new Date().toISOString() }));
    }
    await waitForVite(baseUrl, processState);

    browser = await chromium.launch({ headless: options.headless ?? true });
    context = await browser.newContext({
      viewport: options.viewport ?? { width: 1440, height: 1000 },
      locale: options.locale ?? 'en-US',
      serviceWorkers: 'block',
    });
    for (const route of options.httpRoutes ?? []) {
      await context.route(route.url, route.handler);
    }
    page = await context.newPage();
    for (const route of options.webSocketRoutes ?? []) {
      await page.routeWebSocket(route.url, route.handler);
    }
    page.on('console', (message) => {
      consoleEntries.push({ type: message.type(), text: message.text(), location: message.location() });
    });
    page.on('pageerror', (error) => pageErrors.push(errorText(error)));
    page.on('requestfailed', (request) => {
      requestFailures.push({ url: request.url(), method: request.method(), failure: request.failure() });
    });

    await scenario({
      baseUrl,
      browser,
      context,
      page,
      evidenceDir,
      consoleEntries,
      pageErrors,
      requestFailures,
    });
    lifecycle.result = 'passed';
  } catch (error) {
    scenarioError = error;
    lifecycle.error = errorText(error);
  } finally {
    if (page) {
      await page.close().catch((error) => {
        lifecycle.pageCloseError = errorText(error);
      });
      lifecycle.pageClosed = page.isClosed();
    }
    if (context) {
      await context.close().then(() => {
        lifecycle.contextClosed = true;
      }).catch((error) => {
        lifecycle.contextCloseError = errorText(error);
      });
    }
    if (browser) {
      await browser.close().then(() => {
        lifecycle.browserClosed = true;
      }).catch((error) => {
        lifecycle.browserCloseError = errorText(error);
      });
    }
    await stopProcessGroup(viteProcess).then(() => {
      lifecycle.viteStopped = true;
    }).catch((error) => {
      lifecycle.viteStopError = errorText(error);
    });
    try {
      await reservePort();
      lifecycle.portReleased = true;
    } catch (error) {
      lifecycle.portReleaseError = errorText(error);
    }
    lifecycle.finishedAt = new Date().toISOString();
    await Promise.all([
      writeJson(path.join(evidenceDir, 'browser-console.json'), consoleEntries),
      writeJson(path.join(evidenceDir, 'page-errors.json'), pageErrors),
      writeJson(path.join(evidenceDir, 'request-failures.json'), requestFailures),
      writeJson(path.join(evidenceDir, 'vite-output.json'), viteOutput),
      writeJson(path.join(evidenceDir, 'lifecycle.json'), lifecycle),
    ]);
  }

  if (scenarioError) throw scenarioError;
  if (!lifecycle.pageClosed || !lifecycle.contextClosed || !lifecycle.browserClosed || !lifecycle.viteStopped || !lifecycle.portReleased) {
    throw new Error(`Browser QA cleanup failed; inspect ${path.join(evidenceDir, 'lifecycle.json')}.`);
  }
  return { evidenceDir, lifecycle };
}

export { DEFAULT_QA_URL, QA_HOST, QA_PORT, repositoryRoot };
