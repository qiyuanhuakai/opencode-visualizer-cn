import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSession,
  createWsUrl,
  deleteSession,
  getSession,
  listProjects,
  listSessions,
  readFileContentBytes,
  sendCommand,
  setAuthorization,
  setBaseUrl,
  updateSession,
} from './opencode';

describe('opencode utilities', () => {
  beforeEach(() => {
    setBaseUrl('http://localhost:8080');
    setAuthorization('Bearer token');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('createWsUrl', () => {
    it('converts http to ws without params', () => {
      expect(createWsUrl('/ws')).toBe('ws://localhost:8080/ws');
    });

    it('appends query params', () => {
      expect(createWsUrl('/ws', { a: 1 })).toBe('ws://localhost:8080/ws?a=1');
    });

    it('embeds credentials into the URL', () => {
      expect(createWsUrl('/ws', undefined, { username: 'u', password: 'p' })).toBe(
        'ws://u:p@localhost:8080/ws',
      );
    });
  });

  describe('HTTP wrappers', () => {
    it('listProjects builds correct URL and headers', async () => {
      const mockFetch = vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => '{}',
      } as Response);

      await listProjects('/dir');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/project?directory=%2Fdir',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token',
          }),
        }),
      );
    });

    it('throws on non-OK response', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => '',
      } as Response);

      await expect(listProjects()).rejects.toThrow('/project request failed (500)');
    });

    it('returns null for 204 responses', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 204,
        headers: new Headers(),
        text: async () => '',
      } as Response);

      const result = await listProjects();
      expect(result).toBeNull();
    });

    it('returns null for empty body', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '0' }),
        text: async () => '',
      } as Response);

      const result = await listProjects();
      expect(result).toBeNull();
    });

    it('returns raw text for non-JSON responses', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => 'hello',
      } as Response);

      const result = await getSession('s1');
      expect(result).toBe('hello');
    });

    it('createSession sends POST with correct headers', async () => {
      const mockFetch = vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ id: 's2' }),
        text: async () => '{"id":"s2"}',
      } as Response);

      await createSession('/dir');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/session?directory=%2Fdir',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('updateSession sends PATCH with payload', async () => {
      const mockFetch = vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => '{}',
      } as Response);

      await updateSession('s1', { title: 'New Title', time: { pinned: 123 } }, '/dir');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/session/s1?directory=%2Fdir',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ title: 'New Title', time: { pinned: 123 } }),
        }),
      );
    });

    it('deleteSession sends DELETE request', async () => {
      const mockFetch = vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => '{}',
      } as Response);

      await deleteSession('s1', '/dir');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/session/s1?directory=%2Fdir',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('listSessions builds query with boolean roots', async () => {
      const mockFetch = vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ([]),
        text: async () => '[]',
      } as Response);

      await listSessions({ directory: '/dir', roots: true, search: 'foo', limit: 10 });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/session?directory=%2Fdir&roots=true&search=foo&limit=10',
        expect.anything(),
      );
    });

    it('listSessions omits undefined query values', async () => {
      const mockFetch = vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ([]),
        text: async () => '[]',
      } as Response);

      await listSessions({ directory: '/dir' });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/session?directory=%2Fdir',
        expect.anything(),
      );
    });

    it('sendCommand sends POST with command and arguments', async () => {
      const mockFetch = vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => '{}',
      } as Response);

      await sendCommand('s1', { directory: '/dir', command: 'test', arguments: 'arg1' });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/session/s1/command?directory=%2Fdir',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ directory: '/dir', command: 'test', arguments: 'arg1' }),
        }),
      );
    });

    it('readFileContentBytes preserves auth and directory headers', async () => {
      const bytes = new Uint8Array([0x69, 0x63, 0x6e, 0x73]);
      const mockFetch = vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => bytes.buffer,
      } as Response);

      const result = await readFileContentBytes(
        { directory: '/dir', path: 'icon.icns' },
        { instanceDirectory: '/instance' },
      );

      expect(result).toEqual(bytes);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/file/content?directory=%2Fdir&path=icon.icns',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token',
            'x-opencode-directory': '/instance',
          }),
        }),
      );
    });
  });
});
