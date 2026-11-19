import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { repository } from './runtime-v090-perf-harness.mjs';

export async function buildApp(output, logFile) {
  await mkdir(output, { recursive: true });
  const log = createWriteStream(logFile);
  const child = spawn(process.execPath, [path.join(repository, 'node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner', '--outDir', output, '--emptyOutDir'], { cwd: repository, env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: path.resolve(repository) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await new Promise(resolve => log.end(resolve));
  if (code !== 0) throw new Error(`Production App build failed (${code}): ${logFile}`);
  await mkdir(path.join(output, 'qa'), { recursive: true });
  await build({ entryPoints: [path.join(repository, 'scripts/qa/runtime-v090-perf-drafts.mjs')], bundle: true, format: 'esm', platform: 'browser', outfile: path.join(output, 'qa/drafts.js') });
  return { output, indexBytes: (await stat(path.join(output, 'index.html'))).size };
}

export async function serveApp(output, requestedPort = 0) {
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
  const server = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
      const file = path.resolve(output, `.${pathname === '/' ? '/index.html' : pathname}`);
      const relative = path.relative(output, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
      const info = await stat(file);
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (request.method === 'HEAD') response.end(); else createReadStream(file).pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
