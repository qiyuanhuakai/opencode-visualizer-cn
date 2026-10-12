import { METHODS, ProtocolError, requireValue, objectFields, jsonValue, textValue, integerValue, parseCapabilities } from './capabilities.js';
import { parseEnvironmentId, parseConnectionProfileId, parseHarnessInstanceId, parseSessionRef, decodeWorkspaceKey } from './identity.js';
import { validateFrame, validateChunk, LIMITS } from './protocol.js';
import { validateHarnessManifest, INSPECTION_STATES } from './harnessContract.js';

export const INDEX_COLLECTIONS = Object.freeze(['harnesses', 'workspaces', 'session_summaries', 'interactions', 'operations']);
const fields = {
  'runtime.inspect': [[], []],
  'runtime.target.attach': [['target'], []], 'runtime.target.detach': [['target'], []],
  'runtime.snapshot': [['collection'], ['token', 'cursor', 'limit']],
  'runtime.snapshot.chunk': [['collection', 'key', 'revision', 'offset', 'token'], []],
  'runtime.replay': [['after'], ['limit']], 'runtime.entity.resolve': [['event'], []],
  'runtime.observer.open': [['after'], []], 'runtime.observer.read': [['observerId'], []],
  'runtime.observer.resume': [['observerId', 'after'], []], 'runtime.observer.close': [['observerId'], []],
  'runtime.channel.ack': [['channelId', 'offset', 'length'], []],
  'runtime.channel.finish': [['channelId'], []], 'runtime.channel.cancel': [['channelId'], []],
  'runtime.pty.create': [['workspaceKey', 'command'], ['args', 'cwd']],
  'runtime.pty.read': [['ptyId'], []], 'runtime.pty.write': [['ptyId', 'data'], []],
  'runtime.pty.resize': [['ptyId', 'cols', 'rows'], []], 'runtime.pty.detach': [['ptyId'], []],
};
const native = ['session.list', 'session.get', 'session.history', 'session.create', 'session.send', 'session.cancel', 'interaction.respond'];
export const RUNTIME_WIRE_METHODS = Object.freeze(Object.fromEntries([...Object.keys(fields), 'runtime.channel.open', ...native].map(name => [name, METHODS[name]])));
function bounded(value) {
  const result = jsonValue(value);
  requireValue(new TextEncoder().encode(JSON.stringify(result)).length <= LIMITS.jsonBytes - 1024, 'wire.size');
  return result;
}
function strings(values, maximum) {
  requireValue(Array.isArray(values) && values.length <= maximum, 'wire.list');
  values.forEach(value => textValue(value, 'wire.text'));
}
function role(value) { requireValue(['local', 'execution', 'manager'].includes(value), 'wire.role'); }
function positive(value, name, maximum = Number.MAX_SAFE_INTEGER) { integerValue(value, name, maximum); requireValue(value > 0, name); }
function collection(value) { requireValue(INDEX_COLLECTIONS.includes(value), 'wire.collection'); }
function frame(value, kind) { const parsed = validateFrame(value); requireValue(parsed.kind === kind, 'wire.frame'); return parsed; }
export function parseTargetGrant(input) {
  const value = objectFields(bounded(input), ['target', 'role', 'capabilities', 'permissions', 'workspaceKeys']);
  parseEnvironmentId(value.target); role(value.role); parseCapabilities(value.capabilities);
  strings(value.permissions, 128); requireValue(Array.isArray(value.workspaceKeys) && value.workspaceKeys.length <= 200, 'wire.workspaces');
  value.workspaceKeys.forEach(key => requireValue(decodeWorkspaceKey(key).environmentId === value.target, 'wire.workspace_target'));
  return value;
}
export function parseRuntimeParams(method, input) {
  requireValue(Object.hasOwn(RUNTIME_WIRE_METHODS, method), 'wire.method', 'unsupported');
  const value = bounded(input);
  if (native.includes(method)) {
    objectFields(value, ['harnessInstanceId', 'args'], ['session', 'workspaceKey']);
    parseHarnessInstanceId(value.harnessInstanceId);
    const sessionRequired = !['session.list', 'session.create'].includes(method);
    requireValue(sessionRequired === (value.session !== undefined), 'wire.session');
    if (sessionRequired) requireValue(parseSessionRef(value.session).harnessInstanceId === value.harnessInstanceId, 'wire.harness', 'unauthorized');
    if (value.workspaceKey !== undefined) decodeWorkspaceKey(value.workspaceKey);
    requireValue(value.args !== null && typeof value.args === 'object' && !Array.isArray(value.args), 'wire.args');
    const reserved = ['target', 'environmentId', 'harnessInstanceId', 'session', 'epoch', 'processGeneration', 'permissions', 'idempotencyKey'];
    requireValue(!Object.keys(value.args).some(key => reserved.includes(key)), 'wire.authority', 'unauthorized');
    return value;
  }
  if (method === 'runtime.channel.open') {
    switch (value?.service) {
      case 'file': objectFields(value, ['service', 'workspaceKey', 'path', 'size', 'sha256']); break;
      case 'pty': objectFields(value, ['service', 'ptyId']); break;
      default: throw new ProtocolError('unsupported', 'wire.channel_service');
    }
  } else objectFields(value, ...fields[method]);
  for (const key of ['observerId', 'ptyId', 'token', 'path', 'command', 'cwd']) if (value[key] !== undefined) textValue(value[key], key);
  if (value.key !== undefined) requireValue(typeof value.key === 'string' && value.key.length > 0 && value.key.length <= 4096 && !value.key.includes('\0'), 'wire.key');
  for (const key of ['after', 'revision', 'offset', 'size']) if (value[key] !== undefined) integerValue(value[key], key);
  if (value.target !== undefined) parseEnvironmentId(value.target);
  if (value.workspaceKey !== undefined) decodeWorkspaceKey(value.workspaceKey);
  if (value.collection !== undefined) collection(value.collection);
  if (value.cursor != null) textValue(value.cursor, 'cursor');
  if (value.limit !== undefined) positive(value.limit, 'limit', 200);
  if (value.channelId !== undefined) positive(value.channelId, 'channelId', 0xffffffff);
  if (value.length !== undefined) validateChunk(value);
  if (value.sha256 !== undefined) requireValue(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'sha256');
  if (value.args !== undefined) strings(value.args, 128);
  if (value.data !== undefined) requireValue(typeof value.data === 'string' && new TextEncoder().encode(value.data).length <= LIMITS.binaryBytes, 'pty.input');
  for (const key of ['cols', 'rows']) if (value[key] !== undefined) positive(value[key], key, 1000);
  if (value.event !== undefined) {
    const event = frame(value.event, 'event');
    requireValue(event.type === 'entity.patch', 'wire.patch');
    objectFields(event.payload, ['collection', 'key', 'deleted']); collection(event.payload.collection);
    requireValue(typeof event.payload.key === 'string' && event.payload.key.length <= 4096 && typeof event.payload.deleted === 'boolean', 'wire.patch');
  }
  return value;
}
export function parseRuntimeResult(method, input) {
  requireValue(Object.hasOwn(RUNTIME_WIRE_METHODS, method), 'wire.method', 'unsupported');
  const value = bounded(input);
  switch (method) {
    case 'runtime.inspect':
      objectFields(value, ['role', 'state', 'subscribers', 'topology', 'sources', 'connectionProfileId', 'targets', 'harnesses', 'transports']);
      role(value.role); textValue(value.state, 'state'); integerValue(value.subscribers, 'subscribers'); parseConnectionProfileId(value.connectionProfileId);
      requireValue(Array.isArray(value.topology) && Array.isArray(value.sources), 'wire.topology');
      value.sources.forEach(source => { objectFields(source, ['id', 'state']); textValue(source.id, 'source.id'); textValue(source.state, 'source.state'); });
      requireValue(Array.isArray(value.targets) && value.targets.length <= 32 && Array.isArray(value.harnesses) && value.harnesses.length <= 200, 'wire.inspection');
      value.targets.forEach(parseTargetGrant);
      value.harnesses.forEach(entry => { objectFields(entry, ['manifest', 'inspection']); validateHarnessManifest(entry.manifest); objectFields(entry.inspection, ['state', 'protocolVersion']); requireValue(INSPECTION_STATES.includes(entry.inspection.state) && entry.inspection.protocolVersion === 1, 'wire.inspection'); });
      objectFields(value.transports, ['direct', 'ssh', 'slurm']); requireValue(Object.values(value.transports).every(item => typeof item === 'boolean'), 'wire.transports');
      break;
    case 'runtime.target.attach': objectFields(value, ['hello', 'grant']); frame(value.hello, 'hello'); parseTargetGrant(value.grant); requireValue(value.hello.target === value.grant.target, 'wire.target'); break;
    case 'runtime.snapshot': frame(value, 'snapshot'); break;
    case 'runtime.replay': frame(value, 'replay'); break;
    case 'runtime.observer.read':
      if (value === null) break;
      switch (value.kind) {
        case 'event': case 'control': objectFields(value, ['kind', 'frame']); frame(value.frame, 'event'); break;
        case 'replay_required': objectFields(value, ['kind', 'after', 'through', 'reason']); integerValue(value.after, 'after'); integerValue(value.through, 'through'); requireValue(value.through >= value.after, 'through'); textValue(value.reason, 'reason'); break;
        case 'binary': objectFields(value, ['kind', 'channelId', 'offset', 'length']); validateChunk({ channelId: value.channelId, offset: value.offset, length: value.length }); break;
        default: throw new ProtocolError('invalid_request', 'wire.delivery');
      }
      break;
    case 'runtime.channel.open':
      objectFields(value, ['channelId', 'direction', 'service', 'credits', 'chunkBytes', 'offset']);
      positive(value.channelId, 'channelId', 0xffffffff); integerValue(value.offset, 'offset');
      requireValue(value.credits === 4 && value.chunkBytes === 65536 && ((value.service === 'file' && value.direction === 'upload') || (value.service === 'pty' && value.direction === 'download')), 'wire.channel'); break;
    case 'runtime.channel.ack': objectFields(value, ['channelId', 'offset', 'length']); validateChunk(value); break;
    case 'runtime.channel.finish': objectFields(value, ['path', 'sha256', 'size']); textValue(value.path, 'path'); integerValue(value.size, 'size'); requireValue(/^[a-f0-9]{64}$/.test(value.sha256), 'sha256'); break;
    case 'runtime.observer.open': objectFields(value, ['observerId']); textValue(value.observerId, 'observerId'); break;
    case 'runtime.pty.create': objectFields(value, ['ptyId', 'pid']); textValue(value.ptyId, 'ptyId'); positive(value.pid, 'pid'); break;
    case 'runtime.pty.read':
      objectFields(value, ['chunks', 'exited', 'exitCode', 'bufferedBytes']); requireValue(Array.isArray(value.chunks) && value.chunks.length <= 4, 'wire.chunks'); value.chunks.forEach(validateChunk);
      requireValue(typeof value.exited === 'boolean' && (value.exitCode === null || Number.isInteger(value.exitCode)), 'wire.pty'); integerValue(value.bufferedBytes, 'bufferedBytes'); break;
    case 'runtime.snapshot.chunk':
      objectFields(value, ['revision', 'bytes', 'offset', 'data', 'nextOffset']); for (const key of ['revision', 'bytes', 'offset']) integerValue(value[key], key);
      requireValue(typeof value.data === 'string' && value.data.length <= 87384, 'wire.chunk'); if (value.nextOffset !== null) integerValue(value.nextOffset, 'nextOffset'); break;
    case 'runtime.entity.resolve':
      objectFields(value, ['collection', 'key', 'revision'], ['value', 'chunked', 'bytes']); collection(value.collection); requireValue(typeof value.key === 'string', 'wire.key'); integerValue(value.revision, 'revision'); break;
    case 'session.create': case 'session.send': case 'session.cancel': case 'interaction.respond':
      objectFields(value, ['operationId', 'value']); textValue(value.operationId, 'operationId'); break;
    case 'session.list': case 'session.get': case 'session.history': break;
    default: {
      const key = { 'runtime.target.detach': 'detached', 'runtime.observer.resume': 'resumed', 'runtime.observer.close': 'closed', 'runtime.channel.cancel': 'closed', 'runtime.pty.write': 'written', 'runtime.pty.resize': 'resized', 'runtime.pty.detach': 'detached' }[method];
      requireValue(key !== undefined, 'wire.result'); objectFields(value, [key]); requireValue(value[key] === true, 'wire.result');
    }
  }
  return value;
}

