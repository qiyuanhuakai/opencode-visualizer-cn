import { ProtocolError } from '../../capabilities.js';
export class AcpError extends ProtocolError {
  constructor(code, reason) {
    super(code, `runtime.acp.${reason}`);
    this.name = 'AcpError';
    this.reason = reason;
  }
}
import { jsonValue } from '../../capabilities.js';
export function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AcpError('invalid_request', 'acp_object');
  return value;
}
export function text(value) {
  if (typeof value !== 'string' || !value.length || value.length > 4096)
    throw new AcpError('invalid_request', 'acp_text');
  return value;
}
export function inspectCapabilities(input) {
  const result = record(jsonValue(input));
  if (result.protocolVersion !== 1) throw new AcpError('unsupported', 'acp_version');
  const capabilities = result.agentCapabilities ?? {};
  const sessions = capabilities.sessionCapabilities ?? {};
  return Object.freeze({
    protocolVersion: 1,
    load: capabilities.loadSession === true,
    resume: !!sessions.resume,
    list: !!sessions.list,
    listCompleteness:
      result.agentInfo?.name === 'OpenCode' && result.agentInfo.version === '1.18.34'
        ? 'bounded'
        : 'native',
    concurrent: capabilities._meta?.['vis/sessionConcurrency'] === true,
    authMethods: Array.isArray(result.authMethods) ? result.authMethods : [],
    native: jsonValue(capabilities),
  });
}
export function serialQueue(isConcurrent, assertCurrent) {
  let tail = Promise.resolve();
  let count = 0;
  return (action) => {
    if (count >= 256)
      return Promise.reject(new AcpError('source_unavailable', 'acp_process_queue'));
    count++;
    const run = async () => {
      assertCurrent();
      return action();
    };
    const result = isConcurrent() ? Promise.resolve().then(run) : tail.then(run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      count--;
    });
  };
}
