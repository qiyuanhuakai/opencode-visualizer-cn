// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { downloadDshSession } from './dshSessionExport';
const zip = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]);
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ''; });
function captureDownload() {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this); });
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  return { clicked, create, revoke };
}
it('fetches the authenticated bridge ZIP with descendants and starts a sanitized download', async () => {
  vi.useFakeTimers();
  const capture = captureDownload();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(zip, { headers: { 'content-type': 'application/zip' } }));
  const filename = await downloadDshSession({ bridgeUrl: 'ws://localhost:5000/dsh/ws?ignored=1', bridgeToken: 'test-token', sessionId: 'session/one', fetcher });
  expect(fetcher).toHaveBeenCalledWith('http://localhost:5000/dsh/session.export?sessionId=session%2Fone&includeDescendants=true', { method: 'GET', headers: { Accept: 'application/zip', Authorization: 'Bearer test-token' }, signal: undefined });
  expect(filename).toBe('dsh-session-session_one.zip');
  expect(capture.clicked).toHaveLength(1);
  expect(capture.clicked[0]?.download).toBe(filename);
  expect(capture.create).toHaveBeenCalledOnce();
  expect(document.querySelector('a')).toBeNull();
  await vi.runAllTimersAsync();
  expect(capture.revoke).toHaveBeenCalledWith('blob:export');
});
it.each([
  { status: 404, type: 'application/zip', bytes: zip, message: 'HTTP 404' },
  { status: 200, type: 'application/json', bytes: zip, message: 'did not return a ZIP' },
  { status: 200, type: 'application/zip', bytes: new Uint8Array(), message: 'invalid ZIP' },
])('never downloads a failed or invalid export ($status, $type)', async ({ status, type, bytes, message }) => {
  const capture = captureDownload();
  await expect(downloadDshSession({ bridgeUrl: 'ws://localhost/dsh', sessionId: 's1', fetcher: async () => new Response(bytes, { status, headers: { 'content-type': type } }) })).rejects.toThrow(message);
  expect(capture.create).not.toHaveBeenCalled();
  expect(capture.clicked).toHaveLength(0);
});
it('does not start a download after its session request was aborted', async () => {
  const capture = captureDownload(); const controller = new AbortController();
  await expect(downloadDshSession({ bridgeUrl: 'ws://localhost/dsh', sessionId: 's1', signal: controller.signal, fetcher: async () => { controller.abort(); return new Response(zip, { headers: { 'content-type': 'application/zip' } }); } })).rejects.toThrow();
  expect(capture.create).not.toHaveBeenCalled();
});
