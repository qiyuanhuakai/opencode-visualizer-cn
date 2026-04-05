import { beforeEach, describe, expect, it, vi } from 'vitest';

const serveMock = vi.fn();
const serveStaticMock = vi.fn();
const proxyMock = vi.fn();

vi.mock('@hono/node-server', () => ({
  serve: serveMock,
}));

vi.mock('@hono/node-server/serve-static', () => ({
  serveStatic: serveStaticMock,
}));

vi.mock('hono/proxy', () => ({
  proxy: proxyMock,
}));

describe('server.js', () => {
  beforeEach(() => {
    vi.resetModules();
    serveMock.mockClear();
    serveStaticMock.mockClear();
    proxyMock.mockClear();
  });

  it('uses serveStatic when not in proxy mode', async () => {
    serveStaticMock.mockReturnValue(() => new Response('static'));

    // @ts-ignore JS module without declarations
    await import('../server.js');

    expect(serveStaticMock).toHaveBeenCalled();
    expect(serveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 23003,
        hostname: '127.0.0.1',
      }),
      expect.any(Function),
    );
  });

  it('proxies requests when argv[2] is proxy', async () => {
    const originalArgv = process.argv;
    process.argv = ['node', 'server.js', 'proxy', 'https://example.com'];

    proxyMock.mockImplementation((url) => {
      return new Response(`proxy:${url.href}`);
    });

    // @ts-ignore JS module without declarations
    await import('../server.js');

    expect(serveMock).toHaveBeenCalledTimes(1);
    const appFetch = serveMock.mock.calls[0][0].fetch;
    const request = new Request('http://localhost/test');
    await appFetch(request);

    expect(proxyMock).toHaveBeenCalled();
    const call = proxyMock.mock.calls[0];
    expect(call[0].href).toBe('https://example.com/test');

    process.argv = originalArgv;
  });
});
