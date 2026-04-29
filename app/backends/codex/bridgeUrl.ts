export const CODEX_PROJECT_ID = 'codex';

export function appendCodexBridgeToken(url: string, token?: string) {
  const trimmedToken = token?.trim();
  if (!trimmedToken) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('token', trimmedToken);
  return parsed.toString();
}

export function codexBridgeHttpUrl(bridgeUrl: string, endpoint: `/${string}`) {
  const parsed = new URL(bridgeUrl);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported Codex bridge URL protocol: ${parsed.protocol}`);
  }

  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  if (pathSegments.length > 0) pathSegments.pop();
  const prefix = pathSegments.length > 0 ? `/${pathSegments.join('/')}` : '';
  parsed.pathname = `${prefix}${endpoint}`;
  return parsed.toString();
}
