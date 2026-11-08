import { jsonValue, requireValue, textValue, integerValue } from '../../capabilities.js';

export const OPEN_CODE_VERSION = '1.18.34';
export const OPEN_CODE_LIMITS = Object.freeze({ page: 100, maxPage: 200, frame: 1048576, producer: 4194304, pageBytes: 524288 });
export function pageLimit(value = OPEN_CODE_LIMITS.page) {
  integerValue(value, 'opencode.page', OPEN_CODE_LIMITS.maxPage);
  requireValue(value > 0, 'opencode.page');
  return value;
}
export function summary(value) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'opencode.summary');
  const time = value.time;
  requireValue(time !== null && typeof time === 'object', 'opencode.summary.time');
  const result = {
    id: textValue(value.id, 'opencode.summary.id'),
    projectID: textValue(value.projectID, 'opencode.summary.project'),
    directory: typeof value.directory === 'string' ? value.directory : '',
    title: typeof value.title === 'string' ? value.title : '',
    version: textValue(value.version, 'opencode.summary.version'),
    time: { created: integerValue(time.created, 'opencode.created'), updated: integerValue(time.updated, 'opencode.updated') },
  };
  requireValue(result.directory.length <= 16384 && result.title.length <= 8192, 'opencode.summary.size', 'unsupported');
  if (value.parentID !== undefined && value.parentID !== null) result.parentID = textValue(value.parentID, 'opencode.parent');
  if (time.archived !== undefined && time.archived !== null) result.time.archived = integerValue(time.archived, 'opencode.archived');
  return Object.freeze(result);
}
export function discoveryScope(value = {}) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'opencode.scope');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    requireValue(['projectID', 'directory', 'parentID', 'roots', 'archived'].includes(key), 'opencode.scope.field');
    if (['roots', 'archived'].includes(key)) {
      requireValue(typeof value[key] === 'boolean', 'opencode.scope.boolean');
      result[key] = value[key];
    } else {
      requireValue(typeof value[key] === 'string' && value[key].length <= 16384 && !value[key].includes('\0'), 'opencode.scope.text');
      result[key] = value[key];
    }
  }
  requireValue(!(result.roots === true && result.parentID !== undefined), 'opencode.scope.parent');
  return Object.freeze(result);
}
const confidential = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|headers|env|environment|credentials?)$/i;
export function redactSettings(value) {
  const clean = jsonValue(value);
  const visit = (item) => Array.isArray(item) ? item.map(visit) : item !== null && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, confidential.test(key) ? { redacted: true } : visit(child)])) : item;
  return visit(clean);
}
export function assertNoCredentials(value) {
  const walk = (item) => {
    if (Array.isArray(item)) { for (const child of item) walk(child); return; }
    if (item !== null && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      requireValue(!confidential.test(key), 'opencode.use_credential_ref', 'unauthorized');
      walk(child);
    }
  };
  walk(value);
}
export function nativeEvent(input) {
  const value = jsonValue(input);
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'opencode.event');
  let payload = value.payload ?? value;
  requireValue(payload !== null && typeof payload === 'object' && !Array.isArray(payload), 'opencode.event.payload');
  textValue(payload.type, 'opencode.event.type');
  if (payload.type === 'sync') {
    const sync = payload.syncEvent;
    requireValue(sync !== null && typeof sync === 'object' && !Array.isArray(sync), 'opencode.event.sync');
    requireValue(typeof sync.type === 'string' && sync.type.endsWith('.1'), 'opencode.event.sync_version', 'unsupported');
    textValue(sync.id, 'opencode.event.sync_id');
    requireValue(payload.id === undefined || payload.id === sync.id, 'opencode.event.sync_identity');
    payload = { id: sync.id, type: sync.type.slice(0, -2), properties: sync.data };
  }
  requireValue(payload.properties !== null && typeof payload.properties === 'object' && !Array.isArray(payload.properties), 'opencode.event.properties');
  return { type: payload.type, properties: payload.properties, ...(payload.id === undefined ? {} : { nativeEventId: textValue(payload.id, 'opencode.event.id') }), ...(typeof value.directory === 'string' ? { directory: value.directory } : {}) };
}
