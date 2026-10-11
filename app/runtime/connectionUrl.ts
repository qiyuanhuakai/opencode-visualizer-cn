import type { ErrorCode } from '../../shared/runtime/capabilities.js';
import type { ManagementConnectionCandidate } from '../../shared/runtime/runtimeWire.js';

export class RuntimeConnectionError extends Error {
  constructor(readonly code: ErrorCode) { super(`Runtime connection: ${code}`); this.name = 'RuntimeConnectionError'; }
}

export function normalizeManagementUrl(value: string, legacy = false): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new RuntimeConnectionError('invalid_request'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new RuntimeConnectionError('invalid_request');
  const pathname = url.pathname.replace(/\/+$/u, '');
  if (pathname !== '/runtime' && !(legacy && ['', '/codex', '/acp', '/kimi-web/ws', '/dsh/ws'].includes(pathname))) throw new RuntimeConnectionError('invalid_request');
  url.pathname = '/runtime';
  return url.toString();
}

export function managementCandidate(url: string): ManagementConnectionCandidate {
  return Object.freeze({ url: normalizeManagementUrl(url, true) });
}
