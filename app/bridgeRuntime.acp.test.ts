import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { createBridgeConfigStore } from '../bridge/bridgeConfig.js';
import { createBridgeRuntime } from '../bridge/bridgeRuntime.js';

class TestClient extends EventEmitter {
  readonly sent: string[] = [];

  send(message: string) {
    this.sent.push(message);
    this.emit('sent');
  }

  close() {
    this.emit('close');
  }
}

const reverseAgentScript = [
  "const readline = require('node:readline');",
  "const input = readline.createInterface({ input: process.stdin });",
  'let promptId;',
  "input.on('line', (line) => {",
  '  const message = JSON.parse(line);',
  "  if (message.method === 'session/new') {",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-1' } }) + '\\n');",
  '    return;',
  '  }',
  "  if (message.method === 'session/prompt') {",
  '    promptId = message.id;',
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'fs/read_text_file', params: { sessionId: 'session-1', path: message.params.prompt[0].text } }) + '\\n');",
  '    return;',
  '  }',
  '  if (message.id === 99) {',
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', content: message.result.content } }) + '\\n');",
  '  }',
  '});',
].join('\n');

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('bridge runtime ACP client capabilities', () => {
  it('wires session roots into bridge-owned reverse filesystem requests', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-runtime-acp-'));
    tempDirectories.push(directory);
    const file = path.join(directory, 'context.txt');
    await writeFile(file, 'runtime-content', 'utf8');
    const configStore = createBridgeConfigStore({ configPath: path.join(directory, 'bridge.json') });
    await configStore.load();
    await configStore.upsertAgent({
      id: 'reverse',
      name: 'Reverse ACP',
      command: process.execPath,
      args: ['-e', reverseAgentScript],
      enabled: true,
    });
    const runtime = createBridgeRuntime({
      configStore,
      nativeSupervisor: { start: async () => [], stop: async () => {}, getStatus: () => [] },
    });
    await runtime.start();
    const client = new TestClient();
    runtime.attachAgent('reverse', client);

    client.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: directory, mcpServers: [] },
    }));
    await once(client, 'sent');
    expect(JSON.parse(client.sent[0]!)).toEqual({ jsonrpc: '2.0', id: 1, result: { sessionId: 'session-1' } });

    client.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'session-1', prompt: [{ type: 'text', text: file }] },
    }));
    await once(client, 'sent');
    expect(JSON.parse(client.sent[1]!)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { stopReason: 'end_turn', content: 'runtime-content' },
    });
    await runtime.stop();
  });
});
