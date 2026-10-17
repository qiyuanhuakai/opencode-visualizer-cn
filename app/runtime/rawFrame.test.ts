import { describe, expect, it, vi } from 'vitest';
import { decodeFrame } from '../../shared/runtime/protocol.js';
import { scanRawFrame, type RawFramePreflight } from '../../shared/runtime/rawFrame.js';
import { ProtocolError } from '../../shared/runtime/capabilities.js';
import { HISTORY_LIMITS } from '../../shared/runtime/historyPage.js';

const TARGET = '11111111-1111-4111-8111-111111111111';
const tiny = (count: number) => '[' + '{},'.repeat(count).slice(0, -1) + ']';
function resultFrame(id: string, result: string, ok = true, phase = 'read', extra = ''): string {
  return ok
    ? `{"version":1,"kind":"result","target":"${TARGET}","epoch":"epoch","generation":1,"id":${JSON.stringify(id)},"ok":true,"phase":${JSON.stringify(phase)},"result":${result}${extra}}`
    : `{"version":1,"kind":"result","target":"${TARGET}","epoch":"epoch","generation":1,"id":${JSON.stringify(id)},"ok":false,"typedError":${result}${extra}}`;
}
const budgetPreflight: RawFramePreflight = (summary) => {
  if (summary.kind !== 'result') return 'accept';
  if (summary.result.nodes > HISTORY_LIMITS.nodes || summary.result.depth > HISTORY_LIMITS.depth || summary.result.utf8Bytes > HISTORY_LIMITS.encodedResultBytes) throw new ProtocolError('invalid_request', 'history.structure');
  return 'accept';
};

describe('scanRawFrame bounded lexical summary', () => {
  it('reports envelope primitives and result span metrics without materializing an object graph', () => {
    const hostile = resultFrame('1:1', tiny(174000));
    expect(Buffer.byteLength(hostile)).toBeLessThanOrEqual(1048576);
    const summary = scanRawFrame(hostile);
    expect(summary).toMatchObject({ kind: 'result', version: 1, id: '1:1', target: TARGET, epoch: 'epoch', generation: 1, ok: true, phase: 'read', duplicateKeys: false, unknownFields: false });
    expect(summary.result.nodes).toBe(174001);
    expect(summary.result.depth).toBe(1);
    expect(summary.result.nodes).toBeGreaterThan(HISTORY_LIMITS.nodes);
    expect(Object.keys(summary.result)).toEqual(['utf8Bytes', 'nodes', 'depth', 'stringUnits', 'keyUnits']);
  });

  it('extracts id and binding even when they appear after the result', () => {
    const raw = `{"version":1,"kind":"result","result":[1,2,3],"target":"${TARGET}","epoch":"epoch","generation":7,"id":"9:9","ok":true,"phase":"read"}`;
    const summary = scanRawFrame(raw);
    expect(summary).toMatchObject({ id: '9:9', target: TARGET, epoch: 'epoch', generation: 7 });
    expect(summary.result.nodes).toBe(4);
  });

  it('decodes escaped envelope names and rejects escaped-equivalent duplicate keys preparse', () => {
    const escaped = resultFrame('1:1', '[1]').replace('"id"', '"\\u0069d"');
    expect(scanRawFrame(escaped).id).toBe('1:1');
    const duplicate = `{"version":1,"kind":"result","id":"1:1","\\u0069d":"2:2","target":"${TARGET}","epoch":"e","generation":1,"ok":true,"phase":"read","result":[1]}`;
    expect(scanRawFrame(duplicate).duplicateKeys).toBe(true);
    expect(() => decodeFrame(duplicate, budgetPreflight)).toThrow(expect.objectContaining({ code: 'invalid_request', field: 'frame' }));
  });

  it('flags duplicate version keys and unknown top-level fields', () => {
    const duplicateVersion = `{"version":1,"version":1,"kind":"result","id":"1:1","target":"${TARGET}","epoch":"e","generation":1,"ok":true,"phase":"read","result":[1]}`;
    expect(scanRawFrame(duplicateVersion).duplicateKeys).toBe(true);
    expect(() => decodeFrame(duplicateVersion, budgetPreflight)).toThrow(expect.objectContaining({ field: 'frame' }));
    const unknown = resultFrame('1:1', '[1]', true, 'read', ',"surprise":[1,2,3]');
    expect(scanRawFrame(unknown).unknownFields).toBe(true);
  });

  it('rejects invalid numbers, malformed JSON, wrong version and unknown kinds preparse', () => {
    for (const bad of ['01', '1.', '1e', '-', '1.2.3']) {
      expect(() => decodeFrame(`{"version":1,"kind":"result","id":"1:1","target":"${TARGET}","epoch":"e","generation":${bad},"ok":true,"phase":"read","result":[1]}`, budgetPreflight)).toThrow(expect.objectContaining({ field: 'json' }));
    }
    for (const bad of ['{', '{"version":1', '{"version":1,}', '{"a":}', '{"a" 1}', '{"a":"x', '[1,2']) {
      expect(() => decodeFrame(bad, budgetPreflight)).toThrow(ProtocolError);
    }
    expect(() => decodeFrame(resultFrame('1:1', '[1]').replace('"version":1', '"version":2'), budgetPreflight)).toThrow(expect.objectContaining({ code: 'version_mismatch', field: 'version' }));
    expect(() => decodeFrame(`{"version":1,"kind":"bogus","id":"1:1","target":"${TARGET}","epoch":"e","generation":1,"ok":true,"phase":"read","result":[1]}`, budgetPreflight)).toThrow(expect.objectContaining({ field: 'kind' }));
  });

  it('rejects structurally incomplete result envelopes with a typed failure', () => {
    expect(() => scanRawFrame(`{"version":1,"kind":"result","target":"${TARGET}","epoch":"e","generation":1,"ok":true,"phase":"read","result":[1]}`)).toThrow(expect.objectContaining({ field: 'id' }));
    expect(() => scanRawFrame(`{"version":1,"kind":"result","id":"1:1","target":"${TARGET}","epoch":"e","generation":1,"phase":"read","result":[1]}`)).toThrow(expect.objectContaining({ field: 'ok' }));
    expect(() => scanRawFrame(`{"version":1,"kind":"result","id":"1:1","target":"${TARGET}","epoch":"e","generation":1,"ok":true,"phase":"bogus","result":[1]}`)).toThrow(expect.objectContaining({ field: 'phase' }));
    expect(() => scanRawFrame(`{"version":1,"kind":"result","id":"1:1","target":"${TARGET}","epoch":"e","generation":1,"ok":false}`)).toThrow(expect.objectContaining({ field: 'typedError' }));
  });

  it('reports exact schema node bounds for history control and error results', () => {
    expect(scanRawFrame(resultFrame('1:1', '{"closed":true}')).result.nodes).toBe(2);
    const open = JSON.stringify({ historyId: TARGET, session: { environmentId: TARGET, harnessInstanceId: TARGET, nativeSessionId: 's' }, fence: { id: TARGET, sourceGeneration: 'controlled' }, capabilities: { archive: 'paged', recordStream: true, live: 'invalidate' } });
    expect(scanRawFrame(resultFrame('1:1', open)).result.nodes).toBeLessThanOrEqual(14);
    const errorFrame = resultFrame('1:1', '{"code":"cancelled","message":"bounded"}', false);
    expect(scanRawFrame(errorFrame).typedError.nodes).toBe(3);
  });

  it('counts UTF-8 bytes and decoded string/key units across Unicode and escapes', () => {
    const summary = scanRawFrame(resultFrame('1:1', JSON.stringify({ text: 'héllo→\n\t' })));
    expect(summary.result.stringUnits).toBe(8);
    expect(summary.result.keyUnits).toBe(4);
    expect(summary.result.utf8Bytes).toBe(Buffer.byteLength('{"text":"héllo→\\n\\t"}', 'utf8'));
  });

  it('applies the representation-level raw byte ceiling to whitespace inflation', () => {
    const padded = resultFrame('1:1', '[ ' + ' '.repeat(600000) + '1 ]');
    const summary = scanRawFrame(padded);
    expect(summary.result.utf8Bytes).toBeGreaterThan(HISTORY_LIMITS.encodedResultBytes);
    expect(summary.result.nodes).toBe(2);
    expect(() => decodeFrame(padded, budgetPreflight)).toThrow(expect.objectContaining({ field: 'history.structure' }));
  });
});

describe('decodeFrame preflight overload', () => {
  it('rejects a structurally amplified history result before JSON.parse and body freeze', () => {
    const hostile = resultFrame('1:1', tiny(174000));
    const parse = vi.spyOn(JSON, 'parse');
    const freeze = vi.spyOn(Object, 'freeze');
    try {
      parse.mockClear(); freeze.mockClear();
      expect(() => decodeFrame(hostile, budgetPreflight)).toThrow(expect.objectContaining({ code: 'invalid_request', field: 'history.structure' }));
      expect(parse.mock.calls.some(([arg]) => typeof arg === 'string' && arg.length > 500000)).toBe(false);
      expect(freeze.mock.calls.length).toBeLessThan(1000);
    } finally { parse.mockRestore(); freeze.mockRestore(); }
  });

  it('drops a well-formed result when the preflight returns drop, and accepts otherwise', () => {
    expect(decodeFrame(resultFrame('1:1', '[1]'), () => 'drop')).toBeUndefined();
    const frame = decodeFrame(resultFrame('1:1', '[1,2,3]'), budgetPreflight);
    expect(frame).toMatchObject({ kind: 'result', id: '1:1', result: [1, 2, 3] });
  });

  it('keeps generic no-hook decode byte-equivalent to an accepting preflight', () => {
    const raw = resultFrame('1:1', '[1,2,3]');
    expect(decodeFrame(raw)).toEqual(decodeFrame(raw, budgetPreflight));
  });

  it('accepts a matched non-history 174000-object result within 1MiB', () => {
    const frame = decodeFrame(resultFrame('1:1', tiny(174000)), () => 'accept');
    expect(frame?.kind).toBe('result');
  });

  it('accepts an error result without applying the history budget', () => {
    const frame = decodeFrame(resultFrame('1:1', '{"code":"cancelled","message":"bounded"}', false), budgetPreflight);
    expect(frame).toMatchObject({ kind: 'result', ok: false });
  });
});
