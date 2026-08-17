import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSseConnection, createSseEventParser, parsePacket } from './sseConnection';

describe('parsePacket', () => {
  it('returns null for invalid JSON', () => {
    expect(parsePacket('not json')).toBeNull();
  });

  it('returns null when payload is missing or not an object', () => {
    expect(parsePacket('{}')).toBeNull();
    expect(parsePacket('{"payload": 123}')).toBeNull();
  });

  it('returns null when payload.type or payload.properties are missing', () => {
    expect(parsePacket('{"payload": {"type": "x"}}')).toBeNull();
    expect(parsePacket('{"payload": {"properties": {}}}')).toBeNull();
  });

  it('parses a valid packet with directory', () => {
    const result = parsePacket(
      JSON.stringify({
        directory: '/dir',
        payload: { type: 'x', properties: { foo: 1 } },
      }),
    );
    expect(result).toEqual({
      directory: '/dir',
      payload: { type: 'x', properties: { foo: 1 } },
    });
  });

  it('defaults directory to empty string when missing', () => {
    const result = parsePacket(
      JSON.stringify({
        payload: { type: 'x', properties: {} },
      }),
    );
    expect(result).toEqual({
      directory: '',
      payload: { type: 'x', properties: {} },
    });
  });
});

describe('createSseConnection', () => {
  const t = () => new TransformStream<Uint8Array>();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createMockResponse(body: ReadableStream<Uint8Array> | null, status = 200) {
    return {
      ok: status < 400,
      status,
      body,
      headers: new Headers(),
    } as Response;
  }

  function createTrackedStream(chunk?: Uint8Array) {
    const cancel = vi.fn();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
        if (chunk) nextController.enqueue(chunk);
      },
      cancel,
    });
    return { stream, cancel, enqueue: (value: Uint8Array) => controller?.enqueue(value) };
  }

  it('scans tiny unterminated chunks incrementally without re-encoding the pending buffer', () => {
    const scanCounts: number[] = [];
    let encodedBlocks = 0;
    const parser = createSseEventParser(
      () => {},
      {
        onScan: (scannedBytes) => scanCounts.push(scannedBytes),
        onBlockEncoded: () => {
          encodedBlocks += 1;
        },
      },
    );
    const chunk = new Uint8Array([0x78]);
    const chunkCount = 20_000;

    for (let index = 0; index < chunkCount; index += 1) parser.push(chunk);

    expect(scanCounts.reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(
      chunkCount * 2,
    );
    expect(encodedBlocks).toBe(0);
  });

  it('calls onOpen when connection succeeds', async () => {
    const onOpen = vi.fn();
    const onError = vi.fn();
    const { readable } = t();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createMockResponse(readable)),
    );

    const conn = createSseConnection({
      onPacket: vi.fn(),
      onOpen,
      onError,
    });

    conn.connect({ baseUrl: 'http://localhost' });
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());

    conn.disconnect();
  });

  it('calls onPacket for each data line in an SSE block', async () => {
    const onPacket = vi.fn();
    const { writable, readable } = t();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createMockResponse(readable)),
    );

    const conn = createSseConnection({
      onPacket,
      onOpen: vi.fn(),
      onError: vi.fn(),
    });

    conn.connect({ baseUrl: 'http://localhost' });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const payload1 = JSON.stringify({
      payload: { type: 'a', properties: {} },
    });
    const payload2 = JSON.stringify({
      payload: { type: 'b', properties: {} },
    });
    await writer.write(
      encoder.encode(`data: ${payload1}\n\ndata: ${payload2}\n\n`),
    );

    await vi.waitFor(() => expect(onPacket).toHaveBeenCalledTimes(2));
    expect(onPacket).toHaveBeenNthCalledWith(1, {
      directory: '',
      payload: { type: 'a', properties: {} },
    });
    expect(onPacket).toHaveBeenNthCalledWith(2, {
      directory: '',
      payload: { type: 'b', properties: {} },
    });

    conn.disconnect();
    await writer.close();
  });

  it('parses a delimiter split across incoming chunks', async () => {
    const onPacket = vi.fn();
    const { writable, readable } = t();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const payload = JSON.stringify({ payload: { type: 'split', properties: {} } });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createMockResponse(readable)),
    );

    const conn = createSseConnection({
      onPacket,
      onOpen: vi.fn(),
      onError: vi.fn(),
    });
    conn.connect({ baseUrl: 'http://localhost' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    await writer.write(encoder.encode(`data: ${payload}\n`));
    await writer.write(encoder.encode('\n'));

    await vi.waitFor(() => expect(onPacket).toHaveBeenCalledOnce());
    expect(onPacket).toHaveBeenCalledWith({
      directory: '',
      payload: { type: 'split', properties: {} },
    });

    conn.disconnect();
    await writer.close();
  });

  it('preserves a multibyte UTF-8 payload split between chunks', async () => {
    const onPacket = vi.fn();
    const { writable, readable } = t();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const bytes = encoder.encode(
      `data: ${JSON.stringify({
        payload: { type: 'utf8', properties: { text: '🙂' } },
      })}\n\n`,
    );
    const emojiStart = bytes.indexOf(0xf0);
    if (emojiStart < 0) throw new Error('Expected an encoded emoji in the test payload.');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createMockResponse(readable)),
    );

    const conn = createSseConnection({
      onPacket,
      onOpen: vi.fn(),
      onError: vi.fn(),
    });
    conn.connect({ baseUrl: 'http://localhost' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    await writer.write(bytes.slice(0, emojiStart + 1));
    await writer.write(bytes.slice(emojiStart + 1));

    await vi.waitFor(() => expect(onPacket).toHaveBeenCalledOnce());
    expect(onPacket).toHaveBeenCalledWith({
      directory: '',
      payload: { type: 'utf8', properties: { text: '🙂' } },
    });

    conn.disconnect();
    await writer.close();
  });

  it('reports auth error on 401 without reconnecting', async () => {
    const onError = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createMockResponse(null, 401)),
    );

    const conn = createSseConnection({
      onPacket: vi.fn(),
      onOpen: vi.fn(),
      onError,
    });

    conn.connect({ baseUrl: 'http://localhost' });

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Authentication failed.', 401),
    );

    expect(conn.isConnected()).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(fetch).toHaveBeenCalledTimes(1);

    conn.disconnect();
  });

  it('disconnects cleanly and marks not connected', async () => {
    const { readable } = t();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createMockResponse(readable)),
    );

    const conn = createSseConnection({
      onPacket: vi.fn(),
      onOpen: vi.fn(),
      onError: vi.fn(),
    });

    conn.connect({ baseUrl: 'http://localhost' });
    await vi.waitFor(() => expect(conn.isConnected()).toBe(true));

    conn.disconnect();
    expect(conn.isConnected()).toBe(false);
  });

  it('drops a chunk whose read resolved immediately before disconnect', async () => {
    const onPacket = vi.fn();
    const tracked = createTrackedStream();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createMockResponse(tracked.stream)),
    );
    const conn = createSseConnection({
      onPacket,
      onOpen: vi.fn(),
      onError: vi.fn(),
    });
    const chunk = new TextEncoder().encode(
      `data: ${JSON.stringify({ payload: { type: 'session.updated', properties: {} } })}\n\n`,
    );
    conn.connect({ baseUrl: 'http://localhost' });
    await vi.waitFor(() => expect(conn.isConnected()).toBe(true));

    tracked.enqueue(chunk);
    conn.disconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(onPacket).not.toHaveBeenCalled();
  });

  it('stops dispatching the current chunk when its first packet disconnects', async () => {
    const tracked = createTrackedStream();
    let conn: ReturnType<typeof createSseConnection>;
    const onPacket = vi.fn(() => conn.disconnect());
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createMockResponse(tracked.stream)),
    );
    conn = createSseConnection({
      onPacket,
      onOpen: vi.fn(),
      onError: vi.fn(),
    });
    const event = `data: ${JSON.stringify({ payload: { type: 'session.updated', properties: {} } })}\n\n`;
    conn.connect({ baseUrl: 'http://localhost' });
    await vi.waitFor(() => expect(conn.isConnected()).toBe(true));

    tracked.enqueue(new TextEncoder().encode(`${event}${event}`));
    await vi.waitFor(() => expect(onPacket).toHaveBeenCalled());

    expect(onPacket).toHaveBeenCalledTimes(1);
  });

  it('reports custom empty-base-url error when baseUrl is empty', async () => {
    const onError = vi.fn();
    const conn = createSseConnection({
      onPacket: vi.fn(),
      onOpen: vi.fn(),
      onError,
    });

    conn.connect({
      baseUrl: '',
      errorMessages: { emptyBaseUrl: 'custom empty url' },
    });

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('custom empty url'),
    );
    expect(conn.isConnected()).toBe(false);
    conn.disconnect();
  });

  it('reports custom authentication-failed error on 401', async () => {
    const onError = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createMockResponse(null, 401)),
    );

    const conn = createSseConnection({
      onPacket: vi.fn(),
      onOpen: vi.fn(),
      onError,
    });

    conn.connect({
      baseUrl: 'http://localhost',
      errorMessages: { authenticationFailed: 'custom auth fail' },
    });

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('custom auth fail', 401),
    );
    conn.disconnect();
  });

  it('reports custom stream-closed error when stream ends', async () => {
    const onError = vi.fn();
    const { writable, readable } = t();
    const writer = writable.getWriter();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createMockResponse(readable)),
    );

    const conn = createSseConnection({
      onPacket: vi.fn(),
      onOpen: vi.fn(),
      onError,
    });

    conn.connect({
      baseUrl: 'http://localhost',
      errorMessages: { streamClosed: 'custom closed' },
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await writer.close();

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('custom closed'),
    );
    conn.disconnect();
  });

  it('cancels the failed reader and aborts only its fetch before reconnecting on an oversized terminated block', async () => {
    const onError = vi.fn();
    const onPacket = vi.fn();
    const first = createTrackedStream();
    const second = new TransformStream<Uint8Array>();
    const secondWriter = second.writable.getWriter();
    const signals: (AbortSignal | null | undefined)[] = [];

    vi.stubGlobal(
      'fetch',
      vi
        .fn((_input: RequestInfo | URL, init?: RequestInit) => {
          signals.push(init?.signal);
          return Promise.resolve(
            createMockResponse(signals.length === 1 ? first.stream : second.readable),
          );
        }),
    );

    const conn = createSseConnection({
      onPacket,
      onOpen: vi.fn(),
      onError,
    });

    conn.connect({ baseUrl: 'http://localhost' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    const oversized = new TextEncoder().encode(`data: ${'x'.repeat(1_048_577)}\n\n`);
    first.enqueue(oversized);

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]?.[0]).toContain('1 MiB');
    expect(onPacket).not.toHaveBeenCalled();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(signals[0]?.aborted).toBe(true);

    vi.advanceTimersByTime(1_000);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(signals[1]?.aborted).toBe(false);
    conn.disconnect();
    expect(signals[1]?.aborted).toBe(true);
    await secondWriter.close();
  });
});
