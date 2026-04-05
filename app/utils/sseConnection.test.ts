import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSseConnection, parsePacket } from './sseConnection';

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
});
