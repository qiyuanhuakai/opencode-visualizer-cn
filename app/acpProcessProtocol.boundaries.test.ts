import { describe, expect, it, vi } from 'vitest';

import { createAcpStdoutForwarder } from '../bridge/acpProcessProtocol.js';

describe('ACP stdout protocol boundaries', () => {
  it('drops only an oversized frame and preserves valid trailing frames', async () => {
    const send = vi.fn();
    const entry = {
      agent: { id: 'agent' },
      status: { state: 'running', droppedFrames: 0 },
      stdoutBuffer: '',
      stdoutQueue: Promise.resolve(),
      pendingAgentResponses: new Map(),
      client: { send },
      clientGeneration: 1,
      child: { stdin: { write: vi.fn() } },
    };
    const entries = new Map([['agent', entry]]);
    const forward = createAcpStdoutForwarder({ entries });
    const valid = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} });

    forward(entry, `${'x'.repeat(2 * 1024 * 1024 + 1)}\n${valid}\n`);
    await entry.stdoutQueue;

    expect(entry.status.droppedFrames).toBe(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(valid);
  });

  it('preserves UTF-8 code points split across stdout chunks', async () => {
    const send = vi.fn();
    const entry = {
      agent: { id: 'agent' },
      status: { state: 'running', droppedFrames: 0 },
      stdoutBuffer: '',
      stdoutQueue: Promise.resolve(),
      pendingAgentResponses: new Map(),
      client: { send },
      clientGeneration: 1,
      child: { stdin: { write: vi.fn() } },
    };
    const entries = new Map([['agent', entry]]);
    const forward = createAcpStdoutForwarder({ entries });
    const frame = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { text: '你好' } })}\n`,
    );
    const split = frame.indexOf(Buffer.from('你')) + 1;

    forward(entry, frame.subarray(0, split));
    forward(entry, frame.subarray(split));
    await entry.stdoutQueue;

    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({ params: { text: '你好' } });
  });
});
