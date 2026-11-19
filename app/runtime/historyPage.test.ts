import { describe, expect, it } from 'vitest';
import { parseHistoryOpen, parseHistoryPage, parseHistoryChunk, parseHistoryChange } from '../../shared/runtime/historyPage.js';
import { parseRuntimeParams } from '../../shared/runtime/runtimeWire.js';
const id = '11111111-1111-4111-8111-111111111111';
const session = { environmentId: id, harnessInstanceId: id, nativeSessionId: 'native' };
const fence = { id, sourceGeneration: 'native-epoch' };
const base = { historyId: id, session, fence };
const descriptor = { id, format: 'native-json-utf8', totalBytes: 3, sha256: 'a'.repeat(64) };
const page = { ...base, pageId: id, items: [], cursor: null, completeness: 'complete' };
describe('bounded history wire values', () => {
  it('preserves opaque inline fields and an envelope descriptor outside the record count', () => {
    const input = { ...page, items: [{ recordId: 'r', kind: 'inline', value: { unknown: ['keep', { nested: 9 }] } }], document: descriptor };
    expect(parseHistoryPage(input)).toEqual(input);
    expect(Object.isFrozen(parseHistoryPage(input).items[0])).toBe(true);
  });
  it('rejects malformed ownership IDs and client authority before accepting params', () => {
    for (const input of [{ historyId: id, session, epoch: 'forged' }, { historyId: 'path', session }, { historyId: id, session, agentId: '' }]) expect(() => parseRuntimeParams('runtime.history.open', input)).toThrow();
    expect(() => parseRuntimeParams('runtime.history.page', { historyId: id, releasePageIds: [id, id] })).toThrow();
    expect(() => parseHistoryOpen({ ...base, capabilities: { archive: 'paged', recordStream: true, live: 'invalidate' }, nativeToken: 'secret' })).toThrow();
  });
  it('rejects inherited fields and accessors without executing getters', () => {
    let touched = false;
    const hostile = { ...page, get cursor() { touched = true; return null; } };
    expect(() => parseHistoryPage(hostile)).toThrow(); expect(touched).toBe(false);
    expect(() => parseHistoryPage(Object.create(page))).toThrow();
  });
  it('refuses structural amplification, oversized inline values and encoded pages', () => {
    for (const value of [Array(4097).fill(0), 'x'.repeat(32769), Array.from({ length: 17 }).reduce<unknown>(value => ({ value }), 0)]) expect(() => parseHistoryPage({ ...page, items: [{ recordId: 'r', kind: 'inline', value }] })).toThrow();
    expect(() => parseHistoryPage({ ...page, items: Array.from({ length: 20 }, (_, i) => ({ recordId: String(i), kind: 'inline', value: 'x'.repeat(30000) })) })).toThrow('history.encoded_size');
    expect(() => parseHistoryPage({ ...page, items: Array.from({ length: 201 }, (_, i) => ({ recordId: String(i), kind: 'inline', value: i })) })).toThrow('history.records');
  });
  it('checks descriptor digest, duplicate IDs and honest completeness', () => {
    for (const input of [{ ...page, document: { ...descriptor, sha256: 'bad' } }, { ...page, items: [{ recordId: 'r', kind: 'stream', descriptor }, { recordId: 's', kind: 'stream', descriptor }] }, { ...page, cursor: id }, { ...page, completeness: 'unsupported', document: descriptor }, { ...page, completeness: 'unsupported', items: [{ recordId: 'r', kind: 'inline', value: 0 }] }]) expect(() => parseHistoryPage(input)).toThrow();
  });
  it('checks canonical base64, decoded ceilings and exact segment continuity', () => {
    const chunk = { historyId: id, fence, pageId: id, descriptorId: id, offset: 0, totalBytes: 3, sha256: descriptor.sha256, data: 'YWJj', nextOffset: null };
    expect(parseHistoryChunk(chunk)).toEqual(chunk);
    for (const patch of [{ data: 'YR==', totalBytes: 1 }, { nextOffset: 3 }, { offset: 1 }, { data: btoa('x'.repeat(65537)), totalBytes: 65537 }, { data: '' }]) expect(() => parseHistoryChunk({ ...chunk, ...patch })).toThrow();
  });
  it('accepts only bounded invalidations without native payloads', () => {
    expect(parseHistoryChange({ historyId: id, fence, through: 2, changed: true, status: 'current' })).toMatchObject({ through: 2 });
    expect(() => parseHistoryChange({ historyId: id, fence, through: 2, changed: true, status: 'current', records: [] })).toThrow();
  });
});
