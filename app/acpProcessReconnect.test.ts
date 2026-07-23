import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAcpClientMethodHandler } from '../bridge/acpClientMethodHandler.js';
import { createAcpProcessManager } from '../bridge/acpProcessManager.js';

class MockClient extends EventEmitter {
  readonly sent: string[] = [];

  send(payload: string | Buffer) {
    this.sent.push(String(payload));
  }

  close() {
    this.emit('close');
  }
}

describe('AcpProcessManager reconnect transport', () => {
  let manager: ReturnType<typeof createAcpProcessManager> | undefined;

  afterEach(async () => {
    await manager?.stopAll();
  });

  it('serves initialize from cache when a new WebSocket attaches to the same agent process', async () => {
    const script = [
      "const readline=require('node:readline')",
      'let initialized=false',
      "readline.createInterface({input:process.stdin}).on('line',(line)=>{",
      'const request=JSON.parse(line)',
      "if(request.method!=='initialize'||initialized)return",
      'initialized=true',
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:'single-init',version:'1'}}})+'\\n')",
      '})',
    ].join(';');
    const observeClientMessage = vi.fn();
    const handleClientRequest = Object.assign(vi.fn(), { observeClientMessage });
    manager = createAcpProcessManager({ handleClientRequest });
    await manager.reconcile([
      {
        id: 'single-init',
        name: 'Single initialize',
        command: process.execPath,
        args: ['-e', script],
        enabled: true,
      },
    ]);
    await vi.waitFor(() => {
      expect(manager?.getStatus().find((status) => status.id === 'single-init')?.state).toBe(
        'running',
      );
    });

    const first = new MockClient();
    manager.attach('single-init', first);
    first.emit(
      'message',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.emit('close');

    const second = new MockClient();
    manager.attach('single-init', second);
    second.emit(
      'message',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    expect(JSON.parse(second.sent[0] ?? '{}')).toMatchObject({
      id: 1,
      result: { protocolVersion: 1 },
    });
    second.emit(
      'message',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: { cwd: '/workspace', mcpServers: [] },
      }),
    );
    await vi.waitFor(() => {
      expect(observeClientMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 2, method: 'session/new' }),
        { agentId: 'single-init' },
      );
    });
  });

  it('binds session roots using the remapped agent request id', async () => {
    const workspace = process.cwd();
    const filePath = path.join(workspace, 'package.json');
    const script = `
      const readline = require('node:readline');
      const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'root-probe', version: '1' } } });
        } else if (message.method === 'session/new') {
          send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's1' } });
          send({ jsonrpc: '2.0', id: 900, method: 'fs/read_text_file', params: { sessionId: 's1', path: ${JSON.stringify(filePath)} } });
        } else if (message.id === 900) {
          const text = message.result?.content?.slice(0, 1) ?? message.error?.message ?? 'missing';
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
        }
      });
    `;
    manager = createAcpProcessManager({ handleClientRequest: createAcpClientMethodHandler() });
    await manager.reconcile([
      {
        id: 'root-probe',
        name: 'Root probe',
        command: process.execPath,
        args: ['-e', script],
        enabled: true,
      },
    ]);
    await vi.waitFor(() => {
      expect(manager?.getStatus().find((status) => status.id === 'root-probe')?.state).toBe(
        'running',
      );
    });
    const client = new MockClient();
    manager.attach('root-probe', client);
    client.emit(
      'message',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    client.emit(
      'message',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'session/new',
        params: { cwd: workspace, mcpServers: [] },
      }),
    );
    await vi.waitFor(() => expect(client.sent).toHaveLength(3));
    expect(client.sent.map((payload) => JSON.parse(payload))).toContainEqual(
      expect.objectContaining({
        method: 'session/update',
        params: expect.objectContaining({
          update: expect.objectContaining({ content: { type: 'text', text: '{' } }),
        }),
      }),
    );
  });
});
