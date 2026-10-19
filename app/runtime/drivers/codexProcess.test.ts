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

/** Controlled-stdio stand-in for the reviewer round a8ee4d9e8 finding 1: `history` with
 * `params.hold` is withheld, any later `history` answers first and then flushes the held one
 * (new response BEFORE the cancelled old response); `echo` answers result-first / id-last. */
const REORDER_FIXTURE = [
  "let buffer = '';",
  'let held = null;',
  'function reply(message) {',
  "  process.stdout.write(JSON.stringify({ result: { data: [{ turnId: 't1', item: { id: 'item-' + message.id, payload: 'x'.repeat(64) } }], nextCursor: null }, id: message.id }) + '\\n');",
  '}',
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk.toString('utf8');",
  '  for (;;) {',
  "    const index = buffer.indexOf('\\n');",
  '    if (index < 0) break;',
  '    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);',
  '    if (!line.trim()) continue;',
  '    const message = JSON.parse(line);',
  "    if (message.method === 'history') {",
  '      if (message.params && message.params.hold === true) {',
  '        held = message;',
  "        process.stderr.write('held\\n');",
  '      } else {',
  '        reply(message);',
  '        if (held) { reply(held); held = null; }',
  '      }',
  "    } else if (message.method === 'echo') {",
  "      process.stdout.write(JSON.stringify({ result: { ok: true, method: message.method }, id: message.id }) + '\\n');",
  '    }',
  '  }',
  '});',
].join('\n');

describe('Codex result-first frame ownership after cancel', () => {
  async function spawnFixture() {
    const { createCodexProcess } =
      await import('../../../bridge/runtime/drivers/codexProcess.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'vis-codex-process-'));
    const script = path.join(dir, 'app-server.mjs');
    await writeFile(script, REORDER_FIXTURE, 'utf8');
    const proc = createCodexProcess({ executable: process.execPath, args: [script] });
    return { proc, dir };
  }

  async function waitForLine(lines: string[], label: string, deadlineMs = 8000): Promise<string> {
    const deadline = Date.now() + deadlineMs;
    while (lines.length === 0) {
      if (Date.now() > deadline) throw new Error(`${label} timed out`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return lines[0] ?? '';
  }

  it('delivers a result-first ordinary response that arrives after a cancelled raw read', async () => {
    const { proc, dir } = await spawnFixture();
    const lines: string[] = [];
    proc.subscribe(
      (line) => lines.push(line),
      () => {},
    );
    try {
      const requestRaw = proc.requestRaw;
      if (!requestRaw) throw new TypeError('missing raw transport');
      // Given a raw read parked on next() whose held frame never delivers a byte.
      const raw = requestRaw(
        JSON.stringify({ id: 1, method: 'history', params: { hold: true } }),
        1,
      );
      const iterator = raw[Symbol.asyncIterator]();
      void iterator.next().catch(() => {});
      await waitFor(() => proc.inspection().stderrBytes > 0);
      await iterator.return?.();

      // When an ordinary request is sent after the cancel, its result-first / id-last response
      // must be delivered by its actual envelope id, not discarded as the cancelled frame.
      proc.send(JSON.stringify({ id: 2, method: 'echo', params: {} }));
      const line = await waitForLine(lines, 'echo after cancel');
      expect(JSON.parse(line)).toEqual({ result: { ok: true, method: 'echo' }, id: 2 });
      expect(proc.inspection().failed).toBe(false);
    } finally {
      await proc.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('owns the new history response when it arrives before the cancelled old response', async () => {
    const { proc, dir } = await spawnFixture();
    const lines: string[] = [];
    proc.subscribe(
      (line) => lines.push(line),
      () => {},
    );
    try {
      const requestRaw = proc.requestRaw;
      if (!requestRaw) throw new TypeError('missing raw transport');
      // Given a cancelled raw read whose frame is still held.
      const held = requestRaw(
        JSON.stringify({ id: 1, method: 'history', params: { hold: true } }),
        1,
      );
      const heldIterator = held[Symbol.asyncIterator]();
      void heldIterator.next().catch(() => {});
      await waitFor(() => proc.inspection().stderrBytes > 0);
      held.cancel?.();

      // When a new raw read is issued and the server answers the new request before the old one.
      const next = requestRaw(JSON.stringify({ id: 2, method: 'history', params: {} }), 2);
      const parts: Buffer[] = [];
      for await (const chunk of next) parts.push(Buffer.from(chunk));
      const frame = JSON.parse(Buffer.concat(parts).toString('utf8')) as {
        id: number;
        result: { data: [{ item: { id: string } }] };
      };

      // Then the new sink owns the id=2 frame; the abandoned id=1 frame is discarded, never
      // routed into the live sink (which previously produced reconcile_required:codex.history_correlation).
      expect(frame.id).toBe(2);
      expect(frame.result.data[0].item.id).toBe('item-2');
      expect(lines).toHaveLength(0);
      expect(proc.inspection().failed).toBe(false);
      expect(proc.inspection().rawPending).toBe(false);
    } finally {
      await proc.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
});

/** Controlled-stdio stand-in for the reviewer round 6138580284 finding 4. `history` with
 * `params.hold` is withheld; a plain `history` flushes the held queue in order and then answers
 * itself, and `flush` with `params.order:'reverse'` flushes the held queue newest-first. A reply's
 * frame size comes from its own request's `params.bytes`, so one frame can be oversized (>4 MiB,
 * the ordinary bound) while another stays small. `echo` is always small. */
const OVERSIZED_STALE_FIXTURE = [
  "let buffer = '';",
  'const held = [];',
  'function reply(message) {',
  "  const bytes = (message.params && Number(message.params.bytes)) || 64;",
  "  const payload = 'x'.repeat(bytes);",
  "  process.stdout.write(JSON.stringify({ result: { data: [{ turnId: 't1', item: { id: 'item-' + message.id, payload } }], nextCursor: null }, id: message.id }) + '\\n');",
  '}',
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk.toString('utf8');",
  '  for (;;) {',
  "    const index = buffer.indexOf('\\n');",
  '    if (index < 0) break;',
  '    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);',
  "    if (!line.trim()) continue;",
  '    const message = JSON.parse(line);',
  "    if (message.method === 'history') {",
  '      if (message.params && message.params.hold === true) {',
  '        held.push(message);',
  "        process.stderr.write('held\\n');",
  '      } else {',
  '        while (held.length) reply(held.shift());',
  '        reply(message);',
  '      }',
  "    } else if (message.method === 'flush') {",
  "      if (message.params && message.params.order === 'reverse') held.reverse();",
  '      while (held.length) reply(held.shift());',
  "    } else if (message.method === 'echo') {",
  "      process.stdout.write(JSON.stringify({ result: { ok: true, method: message.method }, id: message.id }) + '\\n');",
  '    }',
  '  }',
  '});',
].join('\n');

const OVERSIZED = 6 * 1024 * 1024;

describe('Codex oversized stale frame cannot enter a new raw sink (review round 6138580284 item 4)', () => {
  async function spawnFixture() {
    const { createCodexProcess } =
      await import('../../../bridge/runtime/drivers/codexProcess.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'vis-codex-stale-'));
    const script = path.join(dir, 'app-server.mjs');
    await writeFile(script, OVERSIZED_STALE_FIXTURE, 'utf8');
    const proc = createCodexProcess({ executable: process.execPath, args: [script] });
    return { proc, dir };
  }

  async function waitFor(predicate: () => boolean, label: string, deadlineMs = 15000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`${label} was not reached`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Parks a raw read on `next()`, waits until the app-server has withheld its response, cancels it. */
  async function parkAndCancel(proc: CodexProcess, id: number, bytes: number) {
    const requestRaw = proc.requestRaw;
    if (!requestRaw) throw new TypeError('missing raw transport');
    const stale = requestRaw(
      JSON.stringify({ id, method: 'history', params: { hold: true, bytes } }),
      id,
    );
    const iterator = stale[Symbol.asyncIterator]();
    void iterator.next().catch(() => {});
    await waitFor(() => proc.inspection().stderrBytes > 0, 'held history response');
    stale.cancel?.();
  }

  it('drains an oversized stale frame instead of publishing it to the pending raw read', async () => {
    const { proc, dir } = await spawnFixture();
    const lines: string[] = [];
    proc.subscribe(
      (line) => lines.push(line),
      () => {},
    );
    try {
      const requestRaw = proc.requestRaw;
      if (!requestRaw) throw new TypeError('missing raw transport');
      // Given a raw read parked on next() whose OVERSIZED response is withheld, then cancelled.
      await parkAndCancel(proc, 1, OVERSIZED);

      // When a new raw read is issued: the withheld >4 MiB id=1 frame arrives first, then id=2's
      // own (small) response.
      const next = requestRaw(
        JSON.stringify({ id: 2, method: 'history', params: { bytes: 64 } }),
        2,
      );
      const parts: Buffer[] = [];
      for await (const chunk of next) parts.push(Buffer.from(chunk));
      const frame = JSON.parse(Buffer.concat(parts).toString('utf8')) as {
        id: number;
        result: { data: Array<{ item: { id: string; payload: string } }> };
      };

      // Then the live sink owns id=2's frame, and the stale id=1 bytes never reach it.
      expect(frame.id).toBe(2);
      expect(frame.result.data[0].item.id).toBe('item-2');
      expect(frame.result.data[0].item.payload).toHaveLength(64);
      // The real id=2 response must not be displaced into the ordinary channel.
      expect(lines).toHaveLength(0);
      expect(proc.inspection().failed).toBe(false);
      expect(proc.inspection().rawPending).toBe(false);
    } finally {
      await proc.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('fails the pending raw read when the drained frame was its own oversized response', async () => {
    // The mirror ordering: the NEW oversized response arrives first, so draining it destroys the
    // only bytes the pending read will ever get. The stale frame that follows proves it, and the
    // read must fail rather than park forever.
    const { proc, dir } = await spawnFixture();
    const lines: string[] = [];
    proc.subscribe(
      (line) => lines.push(line),
      () => {},
    );
    try {
      const requestRaw = proc.requestRaw;
      if (!requestRaw) throw new TypeError('missing raw transport');
      await parkAndCancel(proc, 1, 64);

      // Ask for the new read and withhold it too, then flush newest-first.
      const next = requestRaw(
        JSON.stringify({ id: 2, method: 'history', params: { hold: true, bytes: OVERSIZED } }),
        2,
      );
      const pending = next[Symbol.asyncIterator]().next().catch((error: unknown) => error);
      await waitFor(() => proc.inspection().stderrBytes >= 10, 'second held history response');
      proc.send(JSON.stringify({ id: 3, method: 'flush', params: { order: 'reverse' } }));

      // id=2's oversized frame is drained (its id is unknowable before the newline), then id=1's
      // frame proves the drained bytes were the pending read's own response.
      await expect(pending).resolves.toMatchObject({ code: 'reconcile_required' });
      expect(lines).toHaveLength(0);
      expect(proc.inspection().failed).toBe(false);
      expect(proc.inspection().rawPending).toBe(false);
    } finally {
      await proc.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('never parks the pending raw read when two unattributable oversized frames arrive', async () => {
    // Both candidates are oversized, so neither can be attributed before its newline. The second
    // drain proves the pending read's response is gone, and it must fail instead of hanging.
    const { proc, dir } = await spawnFixture();
    const lines: string[] = [];
    proc.subscribe(
      (line) => lines.push(line),
      () => {},
    );
    try {
      const requestRaw = proc.requestRaw;
      if (!requestRaw) throw new TypeError('missing raw transport');
      await parkAndCancel(proc, 1, OVERSIZED);

      const next = requestRaw(
        JSON.stringify({ id: 2, method: 'history', params: { hold: true, bytes: OVERSIZED } }),
        2,
      );
      const pending = next[Symbol.asyncIterator]().next().catch((error: unknown) => error);
      await waitFor(() => proc.inspection().stderrBytes >= 10, 'second held history response');
      proc.send(JSON.stringify({ id: 3, method: 'flush', params: { order: 'reverse' } }));

      await expect(pending).resolves.toMatchObject({ code: 'reconcile_required' });
      expect(lines).toHaveLength(0);
      expect(proc.inspection().failed).toBe(false);
      expect(proc.inspection().rawPending).toBe(false);
    } finally {
      await proc.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
