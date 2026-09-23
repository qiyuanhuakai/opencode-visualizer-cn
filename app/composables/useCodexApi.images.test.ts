import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it('opens text history while historical images are still loading', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: { id: 'thr_existing', turns: [{ id: 'turn_img', items: [{ id: 'shot', type: 'imageView', path: '/tmp/shot.png' }] }] },
    });
    const image = deferred<{ dataBase64: string }>();
    mock.adapter.readFile = vi.fn(() => image.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    const selecting = api.selectThread('thr_existing');
    await vi.waitFor(() => expect(mock.adapter.readFile).toHaveBeenCalled());
    await selecting;
    expect(mock.adapter.resumeThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.loadingThread.value).toBe(false);
    image.resolve({ dataBase64: 'AA==' });
    await vi.waitFor(() => expect(api.canonicalHistory.value.flatMap(entry => entry.parts)).toContainEqual(
      expect.objectContaining({ type: 'file', url: 'data:image/png;base64,AA==' }),
    ));
  });

  it('does not attach a late historical image to another selected thread', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn()
      .mockResolvedValueOnce({ thread: { id: 'thr_existing', turns: [{ id: 'turn_img', items: [{ id: 'shot', type: 'imageView', path: '/tmp/shot.png' }] }] } })
      .mockResolvedValueOnce({ thread: { id: 'thr_other', turns: [] } });
    const image = deferred<{ dataBase64: string }>();
    mock.adapter.readFile = vi.fn(() => image.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    await api.selectThread('thr_other');

    image.resolve({ dataBase64: 'AA==' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(api.activeThreadId.value).toBe('thr_other');
    expect(api.canonicalHistory.value.flatMap(entry => entry.parts)).toEqual([]);
  });

  it('sends Codex image input items without degrading them to file text', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    await api.sendPrompt('', {
      threadId: 'thr_existing',
      input: [{ type: 'image', url: 'data:image/png;base64,AA==' }],
    });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
      text: '',
      threadId: 'thr_existing',
      input: [{ type: 'image', url: 'data:image/png;base64,AA==' }],
    });
  });

  it('hydrates images in the turn-completed history refresh', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    mock.adapter.readFile = vi.fn().mockResolvedValue({ dataBase64: 'AA==' });
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_existing',
        turns: [
          { id: 'turn_img', items: [{ id: 'shot', type: 'imageView', path: '/tmp/shot.png' }] },
        ],
      },
    });
    mock.emit({
      method: 'turn/completed',
      params: { threadId: 'thr_existing', turn: { id: 'turn_img', status: 'completed' } },
    });
    await vi.waitFor(() =>
      expect(api.canonicalHistory.value.flatMap((e) => e.parts)).toContainEqual(
        expect.objectContaining({ type: 'file', url: 'data:image/png;base64,AA==' }),
      ),
    );
    api.disconnect();
  });

  it('hydrates a realtime agent image before publishing its local path', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    const read = deferred<{ dataBase64: string }>();
    mock.adapter.readFile = vi.fn(() => read.promise);
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_img',
        item: { id: 'shot', type: 'imageView', path: '/tmp/shot.png' },
      },
    });
    expect(
      api.realtimeHistoryQueue.value.flatMap((e) => e.parts).filter((p) => p.type === 'file'),
    ).toHaveLength(0);
    read.resolve({ dataBase64: 'AA==' });
    await vi.waitFor(() =>
      expect(api.realtimeHistoryQueue.value.flatMap((e) => e.parts)).toContainEqual(
        expect.objectContaining({ type: 'file', url: 'data:image/png;base64,AA==' }),
      ),
    );
    api.disconnect();
  });

  it('ignores realtime image reads after a thread switch', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    const read = deferred<{ dataBase64: string }>();
    mock.adapter.readFile = vi.fn(() => read.promise);
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_img',
        item: { id: 'shot', type: 'imageView', path: '/tmp/shot.png' },
      },
    });
    await api.selectThread('thr_other');
    read.resolve({ dataBase64: 'AA==' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      api.realtimeHistoryQueue.value.flatMap((e) => e.parts).filter((p) => p.type === 'file'),
    ).toHaveLength(0);
    api.disconnect();
  });

  it('retains the sent image preview when the echoed local file cannot be read', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Look', { input: [{ type: 'image', url: 'data:image/png;base64,AA==' }] });
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    mock.adapter.readFile = vi.fn().mockRejectedValue(new Error('File temporarily unavailable'));
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        item: {
          id: 'echo',
          clientId,
          type: 'userMessage',
          content: [{ type: 'localImage', path: '/tmp/upload.png' }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      api.realtimeHistoryQueue.value.flatMap((e) => e.parts).filter((p) => p.type === 'file'),
    ).toEqual([expect.objectContaining({ url: 'data:image/png;base64,AA==' })]);
    api.disconnect();
  });

  it.each(['image', 'localImage'])('keeps sent images single when echoed as %s', async (kind) => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Look', {
      input: [
        { type: 'text', text: 'Look' },
        { type: 'image', url: 'data:image/png;base64,AA==' },
        { type: 'image', url: 'data:image/png;base64,AA==' },
      ],
    });
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    const initial = api.realtimeHistoryQueue.value
      .find((e) => e.info.role === 'user')
      ?.parts.filter((p) => p.type === 'file');
    expect(initial).toHaveLength(2);
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: api.activeThreadId.value,
        turnId: 'turn_1',
        item: {
          type: 'userMessage',
          id: 'echo',
          clientId,
          content: [
            { type: 'text', text: 'Look' },
            ...[0, 1].map((i) =>
              kind === 'image'
                ? { type: 'image', url: 'data:image/png;base64,AA==' }
                : { type: 'localImage', path: '/tmp/sent-' + i + '.png' },
            ),
          ],
        },
      },
    });
    const files = api.realtimeHistoryQueue.value
      .find((e) => e.info.role === 'user')
      ?.parts.filter((p) => p.type === 'file');
    expect(files).toHaveLength(2);
    expect(files?.map((p) => p.id)).toEqual(initial?.map((p) => p.id));
    expect(mock.adapter.sendPrompt).toHaveBeenCalledTimes(1);
    api.disconnect();
  });
});
