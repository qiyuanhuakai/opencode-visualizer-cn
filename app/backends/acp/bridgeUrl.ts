export const ACP_PROJECT_ID = 'acp';

export function normalizeAcpBridgeUrl(bridgeUrl: string) {
  const parsed = new URL(bridgeUrl.trim());
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Unsupported ACP bridge URL protocol: ${parsed.protocol}`);
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.at(-1) === 'codex') segments.pop();
  parsed.pathname = segments.length > 0 ? `/${segments.join('/')}` : '/';
  return parsed.toString().replace(/\/(?=[?#]|$)/u, '');
}

export function acpBridgeHttpUrl(bridgeUrl: string, endpoint: `/${string}`) {
  const parsed = new URL(normalizeAcpBridgeUrl(bridgeUrl));
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  const prefix = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/u, '');
  parsed.pathname = `${prefix}${endpoint}`;
  return parsed.toString();
}

export function acpBridgeWebSocketUrl(bridgeUrl: string, agentId: string, bridgeToken?: string) {
  const parsed = new URL(normalizeAcpBridgeUrl(bridgeUrl));
  if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Unsupported ACP bridge URL protocol: ${parsed.protocol}`);
  }
  const prefix = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/u, '');
  parsed.pathname = `${prefix}/acp/${encodeURIComponent(agentId)}`;
  const token = bridgeToken?.trim();
  if (token) parsed.searchParams.set('token', token);
  return parsed.toString();
}
