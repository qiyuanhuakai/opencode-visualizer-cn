import { parseEnvironmentId, parseInstanceId } from './identity.js';
import { ERROR_CODES, METHODS, ProtocolError, requireValue, objectFields, textValue, integerValue, jsonValue, parseCapabilities } from './capabilities.js';
export { ProtocolError, ERROR_CODES } from './capabilities.js';
export { createProtocolState } from './protocolState.js';
export const PROTOCOL_VERSION = 1;
export const LIMITS = Object.freeze({ jsonBytes: 1048576, binaryBytes: 65536, channelCredits: 4, bulkChannels: 4, outboundBytes: 8388608, snapshotTtlMs: 60000, snapshotTokens: 3, replayBytes: 67108864, replayAgeMs: 86400000 });
const encoder = new TextEncoder();
const base = ['kind', 'version', 'target', 'epoch', 'generation'];
const fields = Object.freeze({
  hello: ['instanceId', 'capabilities'], request: ['id', 'method', 'params'],
  result: ['id', 'ok'], event: ['seq', 'entityRevision', 'scope', 'type', 'payload'],
  snapshot: ['token', 'revision', 'watermark', 'expiresAt', 'items', 'cursor'],
  replay: ['after', 'through', 'events'],
});
export function parseBinding(input) {
  objectFields(input, ['target', 'epoch', 'generation']);
  try { requireValue(parseEnvironmentId(input.target) === input.target, 'target'); }
  catch (error) { if (error instanceof TypeError) throw new ProtocolError('invalid_request', 'target'); throw error; }
  textValue(input.epoch, 'epoch');
  integerValue(input.generation, 'generation');
  return Object.freeze({ target: input.target, epoch: input.epoch, generation: input.generation });
}
export function validateFrame(input) {
  const value = jsonValue(input);
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'frame');
  requireValue(value.version === PROTOCOL_VERSION, 'version', 'version_mismatch');
  requireValue(typeof value.kind === 'string' && Object.hasOwn(fields, value.kind), 'kind');
  const optional = value.kind === 'request' ? ['idempotencyKey'] : value.kind === 'result' ? ['phase', 'result', 'typedError'] : [];
  objectFields(value, [...base, ...fields[value.kind]], optional);
  parseBinding({ target: value.target, epoch: value.epoch, generation: value.generation });
  switch (value.kind) {
    case 'hello':
      try { requireValue(parseInstanceId(value.instanceId) === value.instanceId, 'instanceId'); }
      catch (error) { if (error instanceof TypeError) throw new ProtocolError('invalid_request', 'instanceId'); throw error; }
      parseCapabilities(value.capabilities);
      break;
    case 'request':
      textValue(value.id, 'id');
      requireValue(typeof value.method === 'string' && Object.hasOwn(METHODS, value.method), 'method', 'unsupported');
      if (METHODS[value.method] === 'mutation') textValue(value.idempotencyKey, 'idempotencyKey');
      else if (value.idempotencyKey !== undefined) textValue(value.idempotencyKey, 'idempotencyKey');
      requireValue(value.params !== null && typeof value.params === 'object' && !Array.isArray(value.params), 'params');
      if (value.method === 'native.extension') {
        objectFields(value.params, ['owner', 'name', 'payload']);
        parseCapabilities({ methods: [], extensions: [{ owner: value.params.owner, name: value.params.name, permission: 'required', schemaVersion: 1, metadata: null }] });
      }
      break;
    case 'result':
      textValue(value.id, 'id');
      requireValue(typeof value.ok === 'boolean', 'ok');
      if (value.ok) {
        requireValue(Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'typedError'), 'result');
        requireValue(['read', 'durable-accepted', 'native-executed'].includes(value.phase), 'phase');
        if (value.phase === 'durable-accepted') {
          objectFields(value.result, ['operationId']);
          textValue(value.result.operationId, 'operationId');
        }
      } else {
        requireValue(!Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'phase'), 'typedError');
        objectFields(value.typedError, ['code', 'message']);
        requireValue(ERROR_CODES.includes(value.typedError.code), 'typedError.code');
        textValue(value.typedError.message, 'typedError.message');
      }
      break;
    case 'event':
      integerValue(value.seq, 'seq');
      requireValue(value.seq > 0, 'seq');
      integerValue(value.entityRevision, 'entityRevision');
      textValue(value.scope, 'scope');
      textValue(value.type, 'type');
      break;
    case 'snapshot':
      textValue(value.token, 'token');
      integerValue(value.revision, 'revision');
      integerValue(value.watermark, 'watermark');
      integerValue(value.expiresAt, 'expiresAt');
      requireValue(Array.isArray(value.items) && value.items.length <= 200, 'items');
      if (value.cursor !== null) textValue(value.cursor, 'cursor');
      break;
    case 'replay': {
      integerValue(value.after, 'after');
      integerValue(value.through, 'through');
      requireValue(Array.isArray(value.events) && value.through >= value.after, 'replay');
      let cursor = value.after;
      for (const event of value.events) {
        validateFrame(event);
        requireValue(event.kind === 'event' && event.target === value.target && event.epoch === value.epoch
          && event.generation === value.generation && event.seq === cursor + 1, 'replay.event');
        cursor = event.seq;
      }
      requireValue(cursor === value.through, 'replay.through');
      break;
    }
    default: throw new ProtocolError('invalid_request', 'kind');
  }
  requireValue(encoder.encode(JSON.stringify(value)).byteLength <= LIMITS.jsonBytes, 'json.size');
  return value;
}
export function encodeFrame(value) { return JSON.stringify(validateFrame(value)); }
export function decodeFrame(text) {
  requireValue(typeof text === 'string' && encoder.encode(text).byteLength <= LIMITS.jsonBytes, 'json.size');
  let value;
  try { value = JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) throw new ProtocolError('invalid_request', 'json'); throw error; }
  return validateFrame(value);
}
export function validateChunk(input) {
  objectFields(input, ['channelId', 'offset', 'length']);
  integerValue(input.channelId, 'channelId', 0xffffffff);
  requireValue(input.channelId > 0, 'channelId');
  integerValue(input.offset, 'offset');
  integerValue(input.length, 'length', LIMITS.binaryBytes);
  requireValue(input.length > 0 && Number.isSafeInteger(input.offset + input.length), 'length');
  return Object.freeze({ channelId: input.channelId, offset: input.offset, length: input.length });
}
// Binary v1: 24-byte network-order header: magic RVB1, channel u32, offset u64,
// payload length u32, reserved u32=0. Channel binding is established by the owner state.
export function encodeBinary(input) {
  objectFields(input, ['channelId', 'offset', 'data']);
  requireValue(input.data instanceof Uint8Array, 'data');
  const chunk = validateChunk({ channelId: input.channelId, offset: input.offset, length: input.data.byteLength });
  const bytes = new Uint8Array(24 + chunk.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x52564231);
  view.setUint32(4, chunk.channelId);
  view.setBigUint64(8, BigInt(chunk.offset));
  view.setUint32(16, chunk.length);
  bytes.set(input.data, 24);
  return bytes;
}
export function decodeBinary(bytes) {
  requireValue(bytes instanceof Uint8Array && bytes.byteLength >= 24 && bytes.byteLength <= 24 + LIMITS.binaryBytes, 'binary.size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requireValue(view.getUint32(0) === 0x52564231 && view.getUint32(20) === 0, 'binary.header');
  const chunk = validateChunk({ channelId: view.getUint32(4), offset: Number(view.getBigUint64(8)), length: view.getUint32(16) });
  requireValue(bytes.byteLength === 24 + chunk.length, 'binary.length');
  return Object.freeze({ ...chunk, data: bytes.slice(24) });
}
