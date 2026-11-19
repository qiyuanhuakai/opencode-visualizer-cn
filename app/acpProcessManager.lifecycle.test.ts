import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createAcpProcessManager } from '../bridge/acpProcessManager.js';

class TestClient extends EventEmitter {
  closed = false;
  send() {}
  close() {
    this.closed = true;
    this.emit('close');
  }
}

const agentScript = [
  "const readline=require('node:readline');",
  "process.on('SIGTERM',()=>process.exit(0));",
  'const input=readline.createInterface({input:process.stdin});',
  "input.on('line',(line)=>{const message=JSON.parse(line);process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n')});",
].join('');

describe('ACP process generation lifecycle', () => {
  it('detaches the old client and completes release before resuming a replacement', async () => {
    const events: string[] = [];
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const releaseAgent = vi.fn(async () => {
      events.push('release');
      if (releaseAgent.mock.calls.length === 1) await releaseGate;
    });
    const handleClientRequest = Object.assign(vi.fn(async () => ({})), {
      observeAgentMessage: vi.fn(),
      observeClientMessage: vi.fn(),
      releaseAgent,
      resumeAgent: vi.fn(() => events.push('resume')),
    });
    const manager = createAcpProcessManager({ handleClientRequest });
    const original = {
      id: 'replacement',
      name: 'Replacement ACP',
      command: process.execPath,
      args: ['-e', agentScript],
      enabled: true,
    };
    let replacing: ReturnType<typeof manager.reconcile> | undefined;
    try {
      await manager.reconcile([original]);
      const client = new TestClient();
      manager.attach('replacement', client);

      replacing = manager.reconcile([{ ...original, args: ['-e', agentScript, 'next'] }]);
      await vi.waitFor(() => expect(releaseAgent).toHaveBeenCalledOnce());

      expect(client.closed).toBe(true);
      expect(events).toEqual(['resume', 'release']);
      finishRelease();
      await replacing;
      expect(events).toEqual(['resume', 'release', 'resume']);
    } finally {
      finishRelease();
      try {
        await replacing;
      } finally {
        await manager.stopAll();
      }
    }
  });

  it('drops an oversized unterminated stdout frame without growing the buffer indefinitely', async () => {
    const manager = createAcpProcessManager();
    try {
      await manager.reconcile([
        {
          id: 'oversized-frame',
          name: 'Oversized Frame ACP',
          command: process.execPath,
          args: [
            '-e',
            "process.stdout.write('x'.repeat(2*1024*1024+1));setInterval(()=>{},1000)",
          ],
          enabled: true,
        },
      ]);

      await vi.waitFor(() => {
        expect(manager.getStatus()[0]?.droppedFrames).toBeGreaterThan(0);
      });
    } finally {
      await manager.stopAll();
    }
  });

  it('keeps the agent running and clears the raw tap when a runtime client disconnects', async () => {
    const manager = createAcpProcessManager();
    try {
      await manager.reconcile([
        {
          id: 'runtime-detach',
          name: 'Runtime detach',
          command: process.execPath,
          args: ['-e', agentScript],
          enabled: true,
        },
      ]);
      const client = new TestClient();
      const attachment = manager.attach('runtime-detach', client, { runtime: true });
      const tapped: string[] = [];
      attachment.setRawTap((chunk) => tapped.push(Buffer.from(chunk).toString('utf8')));

      client.close();

      expect(manager.getStatus()[0]).toMatchObject({
        state: 'running',
        owned: true,
        connected: false,
      });
      client.emit(
        'message',
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tapped).toEqual([]);
    } finally {
      await manager.stopAll();
    }
  });
});
