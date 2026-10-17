import { spawn } from 'node:child_process';
export async function captureProcess(invocation, context) {
  const startedAt = new Date().toISOString();
  const chunks = [];
  const ownsGroup = process.platform !== 'win32' && process.env.VIS_RUNTIME_QA_WORKER !== '1';
  const child = spawn(invocation[0], invocation.slice(1), { cwd: context.root, env: context.env ?? process.env, detached: ownsGroup, stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0;
  let interrupted = false;
  let force;
  const kill = (signal) => {
    try { if (ownsGroup && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if (!(error instanceof Error) || error.code !== 'ESRCH') throw error; }
  };
  const terminate = () => { interrupted = true; kill('SIGTERM'); force ??= setTimeout(() => kill('SIGKILL'), 5000); };
  process.once('SIGINT', terminate); process.once('SIGTERM', terminate);
  const timeout = setTimeout(terminate, context.timeoutMs ?? 180000);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { bytes += chunk.length; if (bytes <= 8 * 1024 * 1024) chunks.push(chunk); else terminate(); });
  try {
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(context.log, Buffer.concat(chunks));
    return { ...result, invocation, startedAt, finishedAt: new Date().toISOString(), interrupted, log: context.log };
  } finally { clearTimeout(timeout); clearTimeout(force); process.removeListener('SIGINT', terminate); process.removeListener('SIGTERM', terminate); }
}
