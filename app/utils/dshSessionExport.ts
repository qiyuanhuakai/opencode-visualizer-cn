import { deriveDshBridgeHttpUrl, DshRpcError } from './dshRpc';

type DshSessionExportOptions = {
  readonly bridgeUrl: string;
  readonly bridgeToken?: string;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
};
export async function downloadDshSession(options: DshSessionExportOptions): Promise<string> {
  if (!options.sessionId.trim()) throw new DshRpcError('Select a session to export', { code: 'invalid-argument' });
  const url = new URL(`${deriveDshBridgeHttpUrl(options.bridgeUrl)}/session.export`);
  url.searchParams.set('sessionId', options.sessionId);
  url.searchParams.set('includeDescendants', 'true');
  const headers: Record<string, string> = { Accept: 'application/zip' };
  if (options.bridgeToken) headers.Authorization = `Bearer ${options.bridgeToken}`;
  const response = await (options.fetcher ?? globalThis.fetch)(url.toString(), { method: 'GET', headers, signal: options.signal });
  if (!response.ok) throw new DshRpcError(`Session export failed (HTTP ${response.status})`, { code: 'export-failed' });
  if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/zip') {
    throw new DshRpcError('Session export did not return a ZIP archive', { code: 'invalid-export' });
  }
  const blob = await response.blob();
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (signature[0] !== 0x50 || signature[1] !== 0x4b || !((signature[2] === 3 && signature[3] === 4) || (signature[2] === 5 && signature[3] === 6))) {
    throw new DshRpcError('Session export returned an invalid ZIP archive', { code: 'invalid-export' });
  }
  options.signal?.throwIfAborted();
  const filename = `dsh-session-${options.sessionId.replace(/[^A-Za-z0-9_-]/gu, '_')}.zip`;
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  try { link.click(); } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
  return filename;
}
