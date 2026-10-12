// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexProcess } from '../../../bridge/runtime/drivers/codexProcess.js';

const HISTORY_BYTES = 6 * 1024 * 1024;

/** Controlled-stdio app-server stand-in used to reproduce the reviewer's finding: a `history`
 * request answers with a single >4 MiB raw frame, every other request answers with a small line. */
const FIXTURE = [
  "let buffer = '';",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk.toString('utf8');",
  '  for (;;) {',
  "    const index = buffer.indexOf('\\n');",
  '    if (index < 0) break;',
  '    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);',
  '    if (!line.trim()) continue;',
  '    const message = JSON.parse(line);',
  "    if (message.method === 'history') {",
  `      const payload = 'x'.repeat(${HISTORY_BYTES});`,
  "      const frame = JSON.stringify({ result: { data: [{ turnId: 't1', item: { id: 'item-1', payload } }], nextCursor: null }, id: message.id });",
  "      process.stdout.write(frame + '\\n');",
  "    } else {",
  "      process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true, method: message.method } }) + '\\n');",
  '    }',
  '  }',
  '});',
].join('\n');

async function spawnFixture(): Promise<{
  proc: CodexProcess;
  dir: string;
}> {
  const { createCodexProcess } = await import('../../../bridge/runtime/drivers/codexProcess.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'vis-codex-process-'));
  const script = path.join(dir, 'app-server.mjs');
  await writeFile(script, FIXTURE, 'utf8');
  const proc = createCodexProcess({ executable: process.execPath, args: [script] });
  return { proc, dir };
}

async function waitFor(predicate: () => boolean, deadlineMs = 8000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('native condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Codex raw history cancellation', () => {
  it('resumes the shared stdout and serves a later RPC after a cancelled >4 MiB history read', async () => {
    const { proc, dir } = await spawnFixture();
    const lines: string[] = [];
    proc.subscribe(
      (line) => lines.push(line),
      () => {},
    );
    try {
      // Given a healthy ordinary request.
      proc.send(JSON.stringify({ id: 1, method: 'echo', params: {} }));
      await waitFor(() => lines.length === 1);
      expect(JSON.parse(lines[0] ?? 'null')).toEqual({ id: 1, result: { ok: true, method: 'echo' } });

      // When an oversized history frame is read and the consumer cancels after one chunk.
      const requestRaw = proc.requestRaw;
      if (!requestRaw) throw new TypeError('missing raw transport');
      const raw = requestRaw(JSON.stringify({ id: 2, method: 'history', params: {} }), 2);
      const iterator = raw[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      const chunk = first.value;
      if (!chunk) throw new TypeError('missing first raw chunk');
      expect(chunk.byteLength).toBeGreaterThan(0);
      await iterator.return?.();

      // Then the shared stdout is not left paused: an ordinary RPC still completes.
      proc.send(JSON.stringify({ id: 3, method: 'echo', params: {} }));
      await waitFor(() => lines.length === 2);
      expect(JSON.parse(lines[1] ?? 'null')).toEqual({ id: 3, result: { ok: true, method: 'echo' } });

      // And the raw owner is released so future reads can install a new one.
      await waitFor(() => proc.inspection().rawPending === false);
      expect(proc.inspection().failed).toBe(false);
      const next = requestRaw(JSON.stringify({ id: 4, method: 'history', params: {} }), 4);
      const nextIterator = next[Symbol.asyncIterator]();
      const nextChunk = await nextIterator.next();
      expect(nextChunk.done).toBe(false);
      if (nextChunk.value) expect(nextChunk.value.byteLength).toBeGreaterThan(0);
      await nextIterator.return?.();
    } finally {
      await proc.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('discards a bounded frame that was cancelled before any chunk arrived', async () => {
    const { proc, dir } = await spawnFixture();
    const lines: string[] = [];
    proc.subscribe(
      (line) => lines.push(line),
      () => {},
    );
    try {
      const requestRaw = proc.requestRaw;
      if (!requestRaw) throw new TypeError('missing raw transport');
      // Given a raw history request whose first chunk has not arrived yet.
      const raw = requestRaw(JSON.stringify({ id: 1, method: 'history', params: {} }), 1);
      const iterator = raw[Symbol.asyncIterator]();
      if (typeof iterator.return !== 'function') throw new TypeError('missing raw cleanup path');
      await iterator.return?.();

      // When an ordinary RPC is sent after the cancellation.
      proc.send(JSON.stringify({ id: 2, method: 'echo', params: {} }));

      // Then it succeeds: the in-flight frame is discarded up to its newline, stdout resumed.
      await waitFor(() => lines.length === 1);
      expect(JSON.parse(lines[0] ?? 'null')).toEqual({ id: 2, result: { ok: true, method: 'echo' } });
      await waitFor(() => proc.inspection().rawPending === false);
      expect(proc.inspection().failed).toBe(false);
    } finally {
      await proc.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('keeps the non-cancelled oversized raw read byte-identical', async () => {
    const { proc, dir } = await spawnFixture();
    try {
      const requestRaw = proc.requestRaw;
      if (!requestRaw) throw new TypeError('missing raw transport');
      const raw = requestRaw(JSON.stringify({ id: 1, method: 'history', params: {} }), 1);
      const parts: Buffer[] = [];
      for await (const chunk of raw) parts.push(Buffer.from(chunk));
      const frame = Buffer.concat(parts).toString('utf8');
      expect(Buffer.byteLength(frame)).toBeGreaterThan(4 * 1024 * 1024);
      const parsed = JSON.parse(frame) as {
        id: number;
        result: { data: [{ item: { id: string; payload: string } }] };
      };
      expect(parsed.id).toBe(1);
      expect(parsed.result.data[0].item.id).toBe('item-1');
      expect(parsed.result.data[0].item.payload).toHaveLength(HISTORY_BYTES);
      expect(proc.inspection().failed).toBe(false);
    } finally {
      await proc.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
});
