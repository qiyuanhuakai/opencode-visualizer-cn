import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KimiWebError,
  KimiWebTransportError,
  createKimiWebClient,
  type KimiWebClient,
} from './kimiWeb';

const BASE = 'http://localhost:23004/kimi-web';
const TOKEN = 'bridge-token-123';
const SID = 'session_a3416a3a-2546-4b4d-a7c3-51929a24fa27';

function envelope(data: unknown, code = 0, msg = 'success') {
  return { code, msg, data, request_id: '01M30ZG9NT01FN432NDH8KZJ6M' };
}

function jsonResponse(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
    text: vi.fn(async () => text),
    json: vi.fn(async () => body),
    arrayBuffer: vi.fn(async () => new TextEncoder().encode(text).buffer),
  } as unknown as Response;
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: vi.fn(async () => ''),
    arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
  } as unknown as Response;
}

function binaryResponse(bytes: Uint8Array, status = 200, contentType = 'application/octet-stream') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    text: vi.fn(async () => ''),
    arrayBuffer: vi.fn(async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ),
  } as unknown as Response;
}

function textResponse(body: string, status = 200, contentType = 'text/plain') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    text: vi.fn(async () => body),
    arrayBuffer: vi.fn(async () => new TextEncoder().encode(body).buffer),
  } as unknown as Response;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  return { url: String(url), init: (init ?? {}) as RequestInit };
}

describe('kimiWeb REST client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: KimiWebClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = createKimiWebClient({ baseUrl: BASE, getToken: () => TOKEN });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('envelope + status-first semantics', () => {
    it('browses host project directories without a session id', async () => {
      const page = { path: '/work', parent: '/', entries: [{ name: 'new-project', path: '/work/new-project', is_dir: true }] };
      fetchMock.mockResolvedValue(jsonResponse(envelope(page)));
      await expect(client.browseDirectories('/work')).resolves.toEqual(page);
      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${BASE}/api/v1/fs:browse?path=%2Fwork`);
      expect(init.method).toBe('GET');
    });
    it('loads the Kimi host home directory for the project picker', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ home: '/home/kimi', recent_roots: [] })));
      await expect(client.getFsHome()).resolves.toEqual({ home: '/home/kimi', recent_roots: [] });
      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${BASE}/api/v1/fs:home`);
      expect(init.method).toBe('GET');
    });
    it('unwraps code=0 envelope data on HTTP 200', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ server_version: '0.43.0' })));

      await expect(client.getMeta()).resolves.toEqual({ server_version: '0.43.0' });
    });

    it('unwraps code=0 envelope data on HTTP 201 (create)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ id: SID }, 0), 201));

      await expect(client.createSession({ title: 'hi' })).resolves.toEqual({ id: SID });
    });

    it('throws KimiWebError{code,msg} for code!=0 on HTTP 200 (delete 404 path)', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(envelope(null, 40401, 'session does not exist'), 200),
      );

      const error = await client.deleteSession(SID).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(KimiWebError);
      expect((error as KimiWebError).name).toBe('KimiWebError');
      expect((error as KimiWebError).code).toBe(40401);
      expect((error as KimiWebError).msg).toBe('session does not exist');
    });

    it('does not treat code!=0 as success', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ id: SID }, 42401, 'boom'), 200));

      await expect(client.getMeta()).rejects.toBeInstanceOf(KimiWebError);
    });

    it('returns success for HTTP 204 without attempting to parse the body', async () => {
      const response = emptyResponse(204);
      fetchMock.mockResolvedValue(response);

      await expect(client.deleteSession(SID)).resolves.toBeUndefined();
      expect(response.text).not.toHaveBeenCalled();
    });

    it('returns raw bytes for HTTP 206 without parsing an envelope', async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      fetchMock.mockResolvedValue(binaryResponse(bytes, 206));

      const result = await client.downloadFile(SID, 'out.bin');
      expect(result).toEqual(bytes);
    });

    it('returns raw bytes for HTTP 304 without parsing an envelope', async () => {
      const bytes = new Uint8Array([9, 9]);
      fetchMock.mockResolvedValue(binaryResponse(bytes, 304));

      const result = await client.downloadFile(SID, 'cached.bin');
      expect(result).toEqual(bytes);
    });

    it('throws a typed transport error for a non-JSON body on a JSON endpoint', async () => {
      fetchMock.mockResolvedValue(textResponse('<html>not json</html>', 200));

      const error = await client.getMeta().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(KimiWebTransportError);
      expect((error as KimiWebTransportError).kind).toBe('malformed-response');
    });

    it('throws a typed transport error (network) when fetch rejects', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      const error = await client.getMeta().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(KimiWebTransportError);
      expect((error as KimiWebTransportError).kind).toBe('network');
      expect((error as KimiWebTransportError).path).toBe('/api/v1/meta');
    });
  });

  describe('request headers', () => {
    it('carries the bridge token as an Authorization bearer header', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({})));

      await client.getMeta();

      const { init } = lastCall(fetchMock);
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    });

    it('calls getToken for every request so rotated tokens take effect', async () => {
      const getToken = vi.fn().mockReturnValueOnce('token-one').mockReturnValueOnce('token-two');
      const rotating = createKimiWebClient({ baseUrl: BASE, getToken });
      fetchMock.mockResolvedValue(jsonResponse(envelope({})));

      await rotating.getMeta();
      await rotating.getAuth();

      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        Authorization: 'Bearer token-one',
      });
      expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
        Authorization: 'Bearer token-two',
      });
    });

    it('supports an async getToken', async () => {
      const asyncClient = createKimiWebClient({
        baseUrl: BASE,
        getToken: async () => TOKEN,
      });
      fetchMock.mockResolvedValue(jsonResponse(envelope({})));

      await asyncClient.getMeta();

      expect(lastCall(fetchMock).init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    });

    it('omits Authorization when no token is available', async () => {
      const anonymous = createKimiWebClient({ baseUrl: BASE, getToken: () => '' });
      fetchMock.mockResolvedValue(jsonResponse(envelope({})));

      await anonymous.getMeta();

      expect(lastCall(fetchMock).init.headers).not.toHaveProperty('Authorization');
    });

    it('normalizes a trailing slash on baseUrl', async () => {
      const slashClient = createKimiWebClient({
        baseUrl: `${BASE}/`,
        getToken: () => TOKEN,
      });
      fetchMock.mockResolvedValue(jsonResponse(envelope({})));

      await slashClient.getMeta();

      expect(lastCall(fetchMock).url).toBe(`${BASE}/api/v1/meta`);
    });
  });

  describe('pagination + query serialization', () => {
    it('serializes the cursor query parameter', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ items: [], has_more: true })));

      await client.getMessages(SID, { cursor: 'msg_0042' });

      expect(lastCall(fetchMock).url).toBe(`${BASE}/api/v1/sessions/${SID}/messages?cursor=msg_0042`);
    });

    it('serializes before_id/after_id/page_size and omits undefined values', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ items: [], has_more: false })));

      await client.getMessages(SID, { before_id: 'msg_9', page_size: 20 });

      const { url } = lastCall(fetchMock);
      expect(url).toBe(`${BASE}/api/v1/sessions/${SID}/messages?before_id=msg_9&page_size=20`);
      expect(url).not.toContain('after_id');
      expect(url).not.toContain('cursor');
    });

    it('serializes listSessions boolean filters', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ items: [], has_more: false })));

      await client.listSessions({ include_archive: true, exclude_empty: false });

      expect(lastCall(fetchMock).url).toBe(
        `${BASE}/api/v1/sessions?include_archive=true&exclude_empty=false`,
      );
    });

    it('defaults pending approval/question listing to status=pending', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ items: [] })));

      await client.listApprovals(SID);
      expect(lastCall(fetchMock).url).toBe(
        `${BASE}/api/v1/sessions/${SID}/approvals?status=pending`,
      );

      await client.listQuestions(SID);
      expect(lastCall(fetchMock).url).toBe(
        `${BASE}/api/v1/sessions/${SID}/questions?status=pending`,
      );
    });
  });

  describe('binary endpoints', () => {
    it('returns raw bytes from the session fs download endpoint', async () => {
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      fetchMock.mockResolvedValue(binaryResponse(bytes, 200, 'application/pdf'));

      const result = await client.downloadFile(SID, 'docs/report.pdf');

      expect(result).toEqual(bytes);
      expect(lastCall(fetchMock).url).toBe(
        `${BASE}/api/v1/sessions/${SID}/fs/docs/report.pdf:download`,
      );
    });

    it('throws KimiWebError when a download returns a JSON error envelope', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(envelope(null, 40001, 'unsupported action: src/index.ts'), 200),
      );

      await expect(client.downloadFile(SID, 'src/index.ts')).rejects.toBeInstanceOf(KimiWebError);
    });

    it('posts multipart form data for uploadFile without a manual content type', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 'f_1', name: 'a.txt' })));
      const file = new Blob(['hello'], { type: 'text/plain' });

      await client.uploadFile({ file, name: 'a.txt' });

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${BASE}/api/v1/files`);
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    });
  });

  describe('endpoint coverage', () => {
    const endpoints: Array<{
      name: string;
      method: string;
      path: string;
      respond?: () => Response;
      run: (c: KimiWebClient) => Promise<unknown>;
    }> = [
      { name: 'getMeta', method: 'GET', path: '/api/v1/meta', run: (c) => c.getMeta() },
      { name: 'getAuth', method: 'GET', path: '/api/v1/auth', run: (c) => c.getAuth() },
      { name: 'listModels', method: 'GET', path: '/api/v1/models', run: (c) => c.listModels() },
      {
        name: 'createSession',
        method: 'POST',
        path: '/api/v1/sessions',
        run: (c) => c.createSession({ title: 't', metadata: { cwd: '/repo' } }),
      },
      {
        name: 'listSessions',
        method: 'GET',
        path: '/api/v1/sessions',
        run: (c) => c.listSessions(),
      },
      {
        name: 'updateProfile',
        method: 'POST',
        path: `/api/v1/sessions/${SID}/profile`,
        run: (c) => c.updateProfile(SID, { agent_config: { model: 'kimi-code/k3' } }),
      },
      {
        name: 'deleteSession',
        method: 'POST',
        path: `/api/v1/sessions/${SID}:delete`,
        run: (c) => c.deleteSession(SID),
      },
      {
        name: 'archiveSession',
        method: 'POST',
        path: `/api/v1/sessions/${SID}:archive`,
        run: (c) => c.archiveSession(SID),
      },
      {
        name: 'restoreSession',
        method: 'POST',
        path: `/api/v1/sessions/${SID}:restore`,
        run: (c) => c.restoreSession(SID),
      },
      {
        name: 'getMessages',
        method: 'GET',
        path: `/api/v1/sessions/${SID}/messages`,
        run: (c) => c.getMessages(SID),
      },
      {
        name: 'btwSession',
        method: 'POST',
        path: `/api/v1/sessions/${SID}:btw`,
        run: (c) => c.btwSession(SID),
      },
      {
        name: 'sendPrompt',
        method: 'POST',
        path: `/api/v1/sessions/${SID}/prompts`,
        run: (c) => c.sendPrompt(SID, { content: [{ type: 'text', text: 'hi' }] }),
      },
      {
        name: 'steer',
        method: 'POST',
        path: `/api/v1/sessions/${SID}/prompts:steer`,
        run: (c) => c.steer(SID, ['msg_1']),
      },
      {
        name: 'abortPrompt',
        method: 'POST',
        path: `/api/v1/sessions/${SID}/prompts/msg_1:abort`,
        run: (c) => c.abortPrompt(SID, 'msg_1'),
      },
      {
        name: 'abortSession',
        method: 'POST',
        path: `/api/v1/sessions/${SID}:abort`,
        run: (c) => c.abortSession(SID),
      },
      {
        name: 'listApprovals',
        method: 'GET',
        path: `/api/v1/sessions/${SID}/approvals`,
        run: (c) => c.listApprovals(SID),
      },
      {
        name: 'answerApproval',
        method: 'POST',
        path: `/api/v1/sessions/${SID}/approvals/ap_1`,
        run: (c) => c.answerApproval(SID, 'ap_1', { decision: 'approved' }),
      },
      {
        name: 'listQuestions',
        method: 'GET',
        path: `/api/v1/sessions/${SID}/questions`,
        run: (c) => c.listQuestions(SID),
      },
      {
        name: 'answerQuestion',
        method: 'POST',
        path: `/api/v1/sessions/${SID}/questions/q_1`,
        run: (c) =>
          c.answerQuestion(SID, 'q_1', { answers: { q0: { kind: 'single', option_id: 'o1' } } }),
      },
      {
        name: 'dismissQuestion',
        method: 'POST',
        path: `/api/v1/sessions/${SID}/questions/q_1:dismiss`,
        run: (c) => c.dismissQuestion(SID, 'q_1'),
      },
      {
        name: 'getSessionStatus',
        method: 'GET',
        path: `/api/v1/sessions/${SID}/status`,
        run: (c) => c.getSessionStatus(SID),
      },
      {
        name: 'getSnapshot',
        method: 'GET',
        path: `/api/v1/sessions/${SID}/snapshot`,
        run: (c) => c.getSnapshot(SID),
      },
      {
        name: 'uploadFile',
        method: 'POST',
        path: '/api/v1/files',
        run: (c) => c.uploadFile({ file: new Blob(['x']) }),
      },
      {
        name: 'downloadFile',
        method: 'GET',
        path: `/api/v1/sessions/${SID}/fs/out.bin:download`,
        respond: () => binaryResponse(new Uint8Array([1, 2])),
        run: (c) => c.downloadFile(SID, 'out.bin'),
      },
    ];

    it.each(endpoints)('$name sends $method $path', async ({ method, path, respond, run }) => {
      fetchMock.mockResolvedValue(respond ? respond() : jsonResponse(envelope({})));

      await run(client);

      const { url, init } = lastCall(fetchMock);
      expect(init.method).toBe(method);
      expect(url.startsWith(`${BASE}${path}`)).toBe(true);
    });

    it('encodes ids and sub-paths in requested URLs', async () => {
      const bytes = new Uint8Array([1]);
      fetchMock.mockResolvedValue(binaryResponse(bytes));

      await client.downloadFile(SID, 'a b/c#d.txt');

      expect(lastCall(fetchMock).url).toBe(
        `${BASE}/api/v1/sessions/${SID}/fs/a%20b/c%23d.txt:download`,
      );
    });

    it('addresses a native btw prompt to the returned child agent', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({})));
      await client.sendPrompt(SID, { agent_id: 'agent-0', content: [{ type: 'text', text: 'side question' }] });
      const { init } = lastCall(fetchMock);
      expect(JSON.parse(String(init.body))).toEqual({ agent_id: 'agent-0', content: [{ type: 'text', text: 'side question' }] });
    });
  });

  describe('request bodies', () => {
    it('sends createSession as a snake_case wire body with metadata.cwd', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ id: SID }, 0), 201));

      await client.createSession({ title: 'My chat', metadata: { cwd: '/repo' } });

      expect(lastCall(fetchMock).init.body).toBe(
        JSON.stringify({ title: 'My chat', metadata: { cwd: '/repo' } }),
      );
    });

    it('profile updates accept a mode patch without a model', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ id: SID })));

      await client.updateProfile(SID, { agent_config: { permission_mode: 'auto' } });

      const body = JSON.parse(String(lastCall(fetchMock).init.body));
      expect(body).toEqual({ agent_config: { permission_mode: 'auto' } });
      expect(body.agent_config).not.toHaveProperty('model');
    });

    it('sends the approval answer payload verbatim', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ resolved: true })));

      await client.answerApproval(SID, 'ap_1', {
        decision: 'rejected',
        feedback: 'not now',
        selected_label: 'deny',
      });

      expect(lastCall(fetchMock).init.body).toBe(
        JSON.stringify({ decision: 'rejected', feedback: 'not now', selected_label: 'deny' }),
      );
    });

    it('sends steer as a snake_case prompt_ids body', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ steered: true, prompt_ids: ['msg_1'] })));

      await client.steer(SID, ['msg_1', 'msg_2']);

      expect(lastCall(fetchMock).init.body).toBe(
        JSON.stringify({ prompt_ids: ['msg_1', 'msg_2'] }),
      );
    });
  });

  describe('provider management', () => {
    const model = {
      model: 'gpt-4.1',
      name: 'GPT-4.1',
      max_context_size: 128_000,
      capabilities: ['tool_use'],
    };

    it('lists providers from the measured wire endpoint', async () => {
      const items = [
        {
          id: 'custom/openai',
          type: 'openai',
          has_api_key: false,
          status: 'unconfigured',
          models: [],
        },
      ];
      fetchMock.mockResolvedValue(jsonResponse(envelope({ items })));

      expect(client.listKimiWebProviders).toBeTypeOf('function');
      await expect(client.listKimiWebProviders()).resolves.toEqual({ items });
      expect(lastCall(fetchMock).url).toBe(`${BASE}/api/v1/providers`);
      expect(lastCall(fetchMock).init.method).toBe('GET');
    });

    it('creates a provider with snake_case model objects', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 'custom-openai' }), 201));

      expect(client.createKimiWebProvider).toBeTypeOf('function');
      await client.createKimiWebProvider({
        id: 'custom-openai',
        type: 'openai',
        base_url: 'https://api.example.com/v1',
        api_key: 'secret',
        models: [model],
      });

      expect(lastCall(fetchMock).init.body).toBe(
        JSON.stringify({
          id: 'custom-openai',
          type: 'openai',
          base_url: 'https://api.example.com/v1',
          api_key: 'secret',
          models: [model],
        }),
      );
    });

    it('updates without sending a key and preserves the existing one', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 'custom/openai' })));

      expect(client.updateKimiWebProvider).toBeTypeOf('function');
      await client.updateKimiWebProvider('custom/openai', {
        type: 'openai',
        base_url: 'https://api.example.com/v2',
        models: [model],
      });

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${BASE}/api/v1/providers/custom%2Fopenai`);
      expect(JSON.parse(String(init.body))).toEqual({
        type: 'openai',
        base_url: 'https://api.example.com/v2',
        models: [model],
      });
      expect(JSON.parse(String(init.body))).not.toHaveProperty('api_key');
    });

    it('clears a key with an empty string', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({ id: 'custom-openai' })));

      expect(client.updateKimiWebProvider).toBeTypeOf('function');
      await client.updateKimiWebProvider('custom-openai', {
        type: 'openai',
        api_key: '',
        models: [model],
      });

      expect(JSON.parse(String(lastCall(fetchMock).init.body))).toEqual({
        type: 'openai',
        api_key: '',
        models: [model],
      });
    });

    it('deletes and refreshes through the action routes', async () => {
      fetchMock
        .mockResolvedValueOnce(emptyResponse())
        .mockResolvedValueOnce(jsonResponse(envelope({ changed: [], unchanged: [], failed: [] })))
        .mockResolvedValueOnce(jsonResponse(envelope({})))
        .mockResolvedValueOnce(emptyResponse(200));

      expect(client.deleteKimiWebProvider).toBeTypeOf('function');
      expect(client.refreshKimiWebProvider).toBeTypeOf('function');
      expect(client.refreshAllKimiWebProviders).toBeTypeOf('function');
      expect(client.importKimiWebProviderCatalog).toBeTypeOf('function');
      await client.deleteKimiWebProvider('custom/openai');
      await client.refreshKimiWebProvider('custom/openai');
      await client.refreshAllKimiWebProviders();
      await client.importKimiWebProviderCatalog();

      expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
        [`${BASE}/api/v1/providers/custom%2Fopenai`, 'DELETE'],
        [`${BASE}/api/v1/providers/custom%2Fopenai:refresh`, 'POST'],
        [`${BASE}/api/v1/providers:refresh`, 'POST'],
        [`${BASE}/api/v1/providers:import_catalog`, 'POST'],
      ]);
    });

    it('lists provider catalog entries and fetches encoded ids', async () => {
      const entry = { id: 'custom/openai', name: 'Custom OpenAI', models: [model] };
      fetchMock
        .mockResolvedValueOnce(jsonResponse(envelope({ items: [entry] })))
        .mockResolvedValueOnce(jsonResponse(envelope(entry)));

      expect(client.listKimiWebProviderCatalog).toBeTypeOf('function');
      expect(client.getKimiWebProviderCatalogEntry).toBeTypeOf('function');
      await expect(client.listKimiWebProviderCatalog()).resolves.toEqual({ items: [entry] });
      await expect(client.getKimiWebProviderCatalogEntry('custom/openai')).resolves.toEqual(entry);

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `${BASE}/api/v1/catalog/providers`,
        `${BASE}/api/v1/catalog/providers/custom%2Fopenai`,
      ]);
    });

    it('sets the global default model through an encoded id', async () => {
      fetchMock.mockResolvedValue(jsonResponse(envelope({})));

      expect(client.setKimiWebDefaultModel).toBeTypeOf('function');
      await client.setKimiWebDefaultModel('custom-openai/gpt-4.1');

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${BASE}/api/v1/models/custom-openai%2Fgpt-4.1:set_default`);
      expect(url).not.toContain('/models/custom-openai/gpt-4.1:set_default');
      expect(init.body).toBe(JSON.stringify({}));
    });

    it('surfaces business errors as KimiWebError and transport failures as KimiWebTransportError', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(envelope(null, 40001, 'models are required')))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));

      expect(client.listKimiWebProviders).toBeTypeOf('function');
      await expect(client.listKimiWebProviders()).rejects.toMatchObject({
        name: 'KimiWebError',
        code: 40001,
      });
      await expect(client.listKimiWebProviders()).rejects.toMatchObject({
        name: 'KimiWebTransportError',
        kind: 'network',
      });
    });
  });
});
