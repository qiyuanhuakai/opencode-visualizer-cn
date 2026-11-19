import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const roots = new Map(), waiting = new Map();
let next = 1000;
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const call = (method, params) => new Promise(resolve => {
  const id = next++;
  waiting.set(id, resolve);
  write({ id, method, params });
});
const log = value => appendFileSync(process.env.WRITER_TRACE, JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...value }) + '\n');
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  if (!message.method) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message);
    return;
  }
  const { id, method, params = {} } = message;
  log({ method, params });
  const reply = result => write({ id, result });
  try {
    if (method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { loadSession: process.env.NO_LOAD !== '1', sessionCapabilities: { list: {} } } });
    if (method === 'session/list') {
      if (!roots.size) roots.set('owner', params.cwd);
      return reply({ sessions: [...roots].map(([sessionId, cwd]) => ({ sessionId, cwd, title: sessionId })) });
    }
    if (method === 'session/new') {
      roots.set('same-native-id', params.cwd);
      return reply({ sessionId: 'same-native-id' });
    }
    if (method === 'session/load') {
      roots.set(params.sessionId, params.cwd);
      return reply({});
    }
    if (method === 'session/prompt') {
      const sessionId = params.sessionId, cwd = roots.get(sessionId);
      const own = await call('fs/write_text_file', { sessionId, path: path.join(cwd, 'proof.txt'), content: 'ACP writer output\n' });
      const forbidden = await call('fs/write_text_file', { sessionId, path: path.join(process.env.ORIGINAL_REPOSITORY, 'escape.txt'), content: 'forbidden' });
      const terminal = await call('terminal/create', { sessionId, cwd, command: process.execPath, args: ['-e', "require('fs').writeFileSync('terminal.txt',process.cwd());process.stdout.write(process.cwd())"] });
      if (terminal.error) throw new Error('terminal refused');
      const terminalId = terminal.result.terminalId;
      await call('terminal/wait_for_exit', { sessionId, terminalId });
      const output = await call('terminal/output', { sessionId, terminalId });
      await call('terminal/release', { sessionId, terminalId });
      log({ event: 'writer-completed', sessionId, own, forbidden, output });
      return reply({ stopReason: 'end_turn' });
    }
    reply({});
  } catch (error) {
    write({ id, error: { code: -32603, message: error.message } });
  }
});
