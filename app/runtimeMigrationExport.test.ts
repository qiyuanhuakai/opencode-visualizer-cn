import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { legacyKeyInventory } from './runtime/migration/legacyInventory';
import { openLegacyExport, readLegacyExportPage, legacyDigest } from './runtime/migration/legacyExport';
import { streamStringMap } from '../shared/runtime/migration/streamingJson.js';
import { stringChunks } from '../shared/runtime/migration/streamingJson.js';
import { StorageKeys } from './utils/storageKeys';

async function* source(value = 'body') {
  yield { key: 'opencode.drafts.composer.v1', source: 'localStorage', namespace: 'unattached-legacy-local', content: value, end: true };
}
describe('legacy export', () => {
  it('matches independent SHA256 when secure-context browser crypto is unavailable', async () => {
    // Given empty, Unicode and block boundary vectors; When hashed; Then Node agrees byte for byte.
    for (const value of ['', 'abc', '🦉正文', 'z'.repeat(2 * 1024 * 1024), ...[55, 56, 63, 64, 65, 16384].map(length => 'a'.repeat(length))]) {
      expect(await legacyDigest(value)).toBe(createHash('sha256').update(value).digest('hex'));
    }
  });
  it('covers every persisted registry leaf when inventory is requested', () => {
    // Given the current storage registry; When enumerated; Then every leaf is retained.
    const expected = Object.values(StorageKeys).flatMap(group => Object.values(group).map(key => `opencode.${key}`));
    expect(legacyKeyInventory.filter(entry => entry.registry).map(entry => entry.key).sort()).toEqual(expected.sort());
  });
  it('resumes intact raw chunks when an export is paused', async () => {
    // Given a source; When reopening its token; Then body and digest survive.
    const token = await openLegacyExport(source);
    const page = await readLegacyExportPage(source, { token, limit: 1 });
    expect(page.chunks.map(chunk => chunk.content).join('')).toBe('body');
    expect(page.chunks[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(page.next).toBeNull();
  });
  it('failure refuses a stale token when legacy writes race export', async () => {
    // Given a frozen revision; When source content changes; Then resume fails.
    const token = await openLegacyExport(source);
    await expect(readLegacyExportPage(() => source('changed'), { token })).rejects.toMatchObject({ code: 'source_changed' });
  });
  it('failure withholds credentials in keys and values when exporting ordinary data', async () => {
    // Given synthetic credential-bearing source; When exported; Then secrets stay local.
    async function* secrets() {
      yield* source();
      yield { key: 'opencode.auth.credentials.v1', source: 'localStorage', namespace: 'unattached-legacy-local', content: 'fixture-secret', end: true };
      yield { key: `opencode.kimiWebSessionModes.${encodeURIComponent('["https://u:fixture-secret@host", "session"]')}`, source: 'localStorage', namespace: 'unattached-legacy-local', content: 'safe', end: true };
      yield { key: 'opencode.auth.serverUrl.v1', source: 'localStorage', namespace: 'unattached-legacy-local', content: 'https://host/?token=fixture-secret', end: true };
    }
    const token = await openLegacyExport(secrets);
    const page = await readLegacyExportPage(secrets, { token });
    expect(page.chunks).toHaveLength(2);
    expect(JSON.stringify({ token, page })).not.toContain('fixture-secret');
  });
  it.each(['https://host/#token=hidden', encodeURIComponent('https://u:hidden@host'), `https://${'u'.repeat(40000)}:hidden@host`])('failure quarantines credential URLs across chunk boundaries', async value => {
    // Given credential-bearing values; When bounded chunks split the URL; Then no value is exported.
    async function* values() { for (const chunk of stringChunks(value)) yield { ...chunk, key: 'opencode.auth.serverUrl.v1', source: 'localStorage', namespace: 'unattached-legacy-local' }; }
    const token = await openLegacyExport(values);
    expect(token.localOnlyRecords).toBe(1);
    expect((await readLegacyExportPage(values, { token })).chunks).toEqual([]);
  });
  it.each([
    ...['%2F', '%22', '%40', '%252F', '%2522', '%2540', '@', '"'].flatMap(delimiter => [
      ['password-' + delimiter, 'https://user:regression-canary' + delimiter + 'tail@host.invalid'],
      ['username-' + delimiter, 'https://regression-canary' + delimiter + 'tail@host.invalid'],
    ]),
    ...['token', 'password', 'client_secret', 'api_key', 'authorization'].flatMap(key => [
      ['query-' + key, 'https://host.invalid/?' + key.toUpperCase() + '=regression-canary'],
      ['encoded-query-' + key, encodeURIComponent(encodeURIComponent('https://host.invalid/?' + key + '=regression-canary'))],
    ]),
  ])('quarantines credential URL %s in scalar and nested metadata across wire splits', async (_id, value) => {
    // Given scalar and nested history metadata with a credential crossing the chunk boundary.
    for (const content of [value, JSON.stringify({ entries: [{ metadata: { endpoint: value } }] }), JSON.stringify({ info: JSON.stringify({ endpoint: value }) })]) {
      for (const split of [1, Math.floor(content.length / 2), content.length - 1]) {
        const values = async function* () {
          yield { key: 'opencode.auth.serverUrl.v1', source: 'localStorage', namespace: 'unattached-legacy-local', content: content.slice(0, split), end: false };
          yield { key: 'opencode.auth.serverUrl.v1', source: 'localStorage', namespace: 'unattached-legacy-local', content: content.slice(split), end: true };
        };
        // When exported; Then the whole record remains local, including already scanned chunks.
        const token = await openLegacyExport(values);
        expect(token.localOnlyRecords).toBe(1);
        expect((await readLegacyExportPage(values, { token, limit: 1 })).chunks).toEqual([]);
      }
    }
  });
  it.each(['%2f', '%22', '%252f', '%2522'].flatMap(delimiter => ['slash', 'unicode', 'mixed'].map(escaping => ({ delimiter, escaping }))))('quarantines $escaping JSON metadata with $delimiter userinfo before percent decoding', async ({ delimiter, escaping }) => {
    // Given valid nested JSON with escaped URL syntax, including a second JSON envelope and URI layers.
    const json = JSON.stringify({ metadata: { endpoint: 'https://u:layer-private-marker' + delimiter + 'tail@edge.invalid/a' } });
    const content = escaping === 'slash' ? json.replaceAll('/', '\\/')
      : json.replaceAll('https:', 'https\\u003a').replaceAll('/', escaping === 'mixed' ? '\\/' : '\\u002f').replaceAll('@', '\\u0040');
    for (const raw of [content, JSON.stringify({ info: content }), JSON.stringify({ info: JSON.stringify({ metadata: { endpoint: JSON.stringify({ info: content }) } }) }), encodeURIComponent(content), encodeURIComponent(encodeURIComponent(content))]) {
      const values = async function* () {
        for (const chunk of stringChunks('x'.repeat(16365) + raw)) yield { ...chunk, key: 'opencode.auth.serverUrl.v1', source: 'localStorage', namespace: 'unattached-legacy-local' };
      };
      // When resuming a bounded export; Then no earlier or later chunk of the credential record escapes.
      const token = await openLegacyExport(values);
      expect(token.localOnlyRecords).toBe(1);
      expect((await readLegacyExportPage(values, { token, limit: 1 })).chunks).toEqual([]);
    }
  });
  it.each(['token', 'password', 'client_secret', 'api_key', 'authorization'])('quarantines JSON and URI escaped query key %s', async key => {
    // Given escaped query separators and keys inside serialized metadata.
    const json = JSON.stringify({ endpoint: 'https://edge.invalid/?' + key.toUpperCase() + '=layer-private-marker' });
    const content = json.replaceAll('/', '\\/').replaceAll('?', '\\u003f').replaceAll('=', '\\u003d').replace(key.toUpperCase(), [...key.toUpperCase()].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
    const values = () => source(encodeURIComponent(encodeURIComponent(content)));
    // When exporting; Then the record remains local.
    const token = await openLegacyExport(values);
    expect(token.localOnlyRecords).toBe(1);
    expect((await readLegacyExportPage(values, { token })).chunks).toEqual([]);
  });
  it.each([
    'https://host.invalid/path/a@b',
    JSON.stringify({ info: JSON.stringify({ endpoint: 'https://host.invalid', email: 'reader@example.invalid' }) }),
    'https://host.invalid/path/with%2Fslash%22quote',
    'https://host.invalid/?description=token&client_secretary=public',
    JSON.stringify({ endpoint: 'https://host.invalid', email: 'reader@example.invalid' }),
    JSON.stringify({ endpoint: 'https://host.invalid/path', body: 'ordinary raw history' }),
    JSON.stringify({ endpoint: 'https://host.invalid/path/%2f%22', email: 'reader@example.invalid' }).replaceAll('/', '\\/'),
    JSON.stringify({ endpoint: 'https://host.invalid/path/%2f%22', email: 'reader@example.invalid' }).replaceAll('https:', 'https\\u003a').replaceAll('/', '\\u002f'),
  ])('preserves noncredential URL data byte for byte', async value => {
    // Given innocent URLs; When exported; Then exact raw content survives.
    const values = () => source(value);
    const token = await openLegacyExport(values);
    expect(token.localOnlyRecords).toBe(0);
    expect((await readLegacyExportPage(values, { token })).chunks.map(chunk => chunk.content).join('')).toBe(value);
  });
  it('streams escaped Unicode without parsing the whole map when chunks split escapes', async () => {
    // Given every possible wire split; When parsed incrementally; Then exact strings survive.
    const values = { x: '🦉\\\n"' + '正文'.repeat(40000), y: '' };
    const encoded = JSON.stringify(values);
    async function* pieces() { for (let i = 0; i < encoded.length; i += 7) yield encoded.slice(i, i + 7); }
    const restored: Record<string, string> = {};
    for await (const piece of streamStringMap(pieces())) restored[piece.key] = (restored[piece.key] ?? '') + piece.content;
    expect(restored).toEqual(values);
  });
  it.each(['{"x":"a","x":"b"}', '{"x":42}', '{"x":"a",}', '{"x":"\\q"}'])('failure rejects malformed string map %s', async encoded => {
    // Given invalid legacy envelope; When streamed; Then it fails explicitly.
    async function* malformed() { yield encoded; }
    await expect((async () => { for await (const _piece of streamStringMap(malformed())) { /* consume */ } })()).rejects.toMatchObject({ code: 'corrupt_source' });
  });
  it('failure rejects corrupt shards when their closing syntax is missing', async () => {
    // Given corrupt source; When streamed; Then corruption is explicit.
    async function* corrupt() { yield '{"x":"unterminated'; }
    await expect((async () => { for await (const _piece of streamStringMap(corrupt())) { /* consume */ } })()).rejects.toMatchObject({ code: 'corrupt_source' });
  });
});
