import { ProtocolError, jsonValue, requireValue } from '../../capabilities.js';

const privateKey =
  /^(?:authorization|proxy.authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|bearer[_-]?token|http[_-]?headers|env[_-]?http[_-]?headers)$/i;
export function record(value, field = 'codex.params') {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), field);
  return value;
}
export function fields(value, allowed) {
  const parsed = record(value);
  requireValue(
    Object.keys(parsed).every((key) => allowed.includes(key)),
    'codex.params.field',
  );
  return parsed;
}
export function nativeArguments(value, allowed) {
  const parsed = fields(value ?? {}, allowed);
  return jsonValue(parsed);
}
export function createPrivacy(secrets = []) {
  function string(value) {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]');
    if (/^https?:\/\//i.test(value) || /^wss?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.username || url.password) {
          url.username = '';
          url.password = '';
        }
        for (const key of url.searchParams.keys())
          if (privateKey.test(key) || key === 'token') url.searchParams.set(key, '[REDACTED]');
        return url.toString();
      } catch {
        return '[invalid URL]';
      }
    }
    return value;
  }
  function clean(value, depth = 0) {
    requireValue(depth <= 64, 'codex.native.depth');
    if (typeof value === 'string') return string(value);
    if (Array.isArray(value)) return value.map((entry) => clean(entry, depth + 1));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .map(([key, entry]) => [
            key,
            privateKey.test(key) ? '[REDACTED]' : clean(entry, depth + 1),
          ]),
      );
    if (value === undefined) return null;
    return value;
  }
  return clean;
}
export function rejectSecretInput(value) {
  const visit = (item) => {
    if (!item || typeof item !== 'object') return;
    for (const [key, nested] of Object.entries(item)) {
      if (privateKey.test(key))
        throw new ProtocolError('invalid_request', 'codex.credentialRef_required');
      if (
        key === 'keyPath' &&
        typeof nested === 'string' &&
        nested.split('.').some((part) => privateKey.test(part))
      )
        throw new ProtocolError('invalid_request', 'codex.credentialRef_required');
      visit(nested);
    }
  };
  visit(value);
}
