import nodeFs, { type PathLike, type Stats } from 'node:fs';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalFileEditor } from '../../electron/localFileEditor.js';

const editors: Array<{ closeAll(): Promise<void> }> = [];

async function replaceFile(localPath: string, content: string): Promise<void> {
  const replacementPath = `${localPath}.replacement`;
  await fs.writeFile(replacementPath, content, 'utf8');
  await fs.rename(replacementPath, localPath);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(editors.splice(0).map((editor) => editor.closeAll()));
});

describe('Electron local file editor', () => {
  it('watches a sandboxed temporary copy and reports application saves', async () => {
    const onChange = vi.fn();
    const editor = createLocalFileEditor({
      onChange,
      watchDelayMs: 10,
    });
    editors.push(editor);

    const opened = await editor.open({
      sessionId: 'session-1',
      applicationPath: '/bin/true',
      fileName: '../example.ts',
      content: 'before',
    });

    expect(path.basename(opened.localPath)).toBe('example.ts');
    await fs.writeFile(opened.localPath, 'after', 'utf8');
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ sessionId: 'session-1', content: 'after' });
    });
  });

  it('keeps reporting consecutive atomic replacement saves', async () => {
    const onChange = vi.fn();
    const editor = createLocalFileEditor({ onChange, watchDelayMs: 10 });
    editors.push(editor);
    const opened = await editor.open({
      sessionId: 'atomic-saves',
      applicationPath: '/bin/true',
      fileName: 'example.ts',
      content: 'before',
    });

    await replaceFile(opened.localPath, 'first');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ sessionId: 'atomic-saves', content: 'first' }));
    await replaceFile(opened.localPath, 'second');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ sessionId: 'atomic-saves', content: 'second' }));
  });

  it('reports an explicit re-save of unchanged content so failed persistence can retry', async () => {
    const onChange = vi.fn();
    const editor = createLocalFileEditor({ onChange, watchDelayMs: 10 });
    editors.push(editor);
    const opened = await editor.open({
      sessionId: 'retry-save',
      applicationPath: '/bin/true',
      fileName: 'example.ts',
      content: 'before',
    });

    await fs.writeFile(opened.localPath, 'retry me', 'utf8');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    await fs.writeFile(opened.localPath, 'retry me', 'utf8');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
  });

  it('rejects relative application paths before launching a process', async () => {
    const editor = createLocalFileEditor({ onChange: vi.fn() });
    editors.push(editor);

    await expect(
      editor.open({
        sessionId: 'session-2',
        applicationPath: 'code',
        fileName: 'example.ts',
        content: 'before',
      }),
    ).rejects.toThrow('absolute');
  });

  it('cleans a session closed while open is still awaiting filesystem setup', async () => {
    const editor = createLocalFileEditor({ onChange: vi.fn() });
    editors.push(editor);

    const opening = editor.open({
      sessionId: 'close-during-open',
      applicationPath: '/bin/true',
      fileName: 'example.ts',
      content: 'before',
    });
    await editor.close('close-during-open');

    await expect(opening).rejects.toThrow('closed during opening');
  });

  it('removes the temporary directory when staging fails after it is created', async () => {
    let temporaryDirectory = '';
    const originalMkdtemp = fs.mkdtemp.bind(fs);
    const mkdtemp = vi.spyOn(fs, 'mkdtemp').mockImplementationOnce(async (prefix) => {
      temporaryDirectory = await originalMkdtemp(prefix);
      return temporaryDirectory;
    });
    const writeFile = vi
      .spyOn(fs, 'writeFile')
      .mockRejectedValueOnce(new Error('staging failed'));
    const editor = createLocalFileEditor({ onChange: vi.fn() });
    editors.push(editor);

    await expect(
      editor.open({
        sessionId: 'staging-failure',
        applicationPath: process.execPath,
        fileName: 'notes.txt',
        content: 'original',
      }),
    ).rejects.toThrow('staging failed');
    expect(temporaryDirectory).not.toBe('');
    await expect(fs.access(temporaryDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

    mkdtemp.mockRestore();
    writeFile.mockRestore();
  });

  it('retains a failed cleanup for retry and clears the closing marker', async () => {
    const editor = createLocalFileEditor({ onChange: vi.fn() });
    editors.push(editor);
    const opened = await editor.open({
      sessionId: 'retry-cleanup',
      applicationPath: process.execPath,
      fileName: 'notes.txt',
      content: '',
    });
    const rm = vi
      .spyOn(fs, 'rm')
      .mockRejectedValueOnce(new Error('cleanup failed'));

    await expect(editor.close('retry-cleanup')).rejects.toThrow('cleanup failed');
    await expect(fs.access(opened.localPath)).resolves.toBeUndefined();

    rm.mockRestore();
    await editor.close('retry-cleanup');
    await expect(fs.access(opened.localPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const reopened = await editor.open({
      sessionId: 'retry-cleanup',
      applicationPath: process.execPath,
      fileName: 'notes.txt',
      content: '',
    });
    await editor.close('retry-cleanup');
    await expect(fs.access(reopened.localPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an oversized external save before reading its content', async () => {
    const onError = vi.fn();
    const editor = createLocalFileEditor({
      onChange: vi.fn(),
      onError,
      launchApplication: async () => undefined,
      watchDelayMs: 5,
    });
    editors.push(editor);
    const opened = await editor.open({
      sessionId: 'oversized-save',
      applicationPath: process.execPath,
      fileName: 'notes.txt',
      content: '',
      maxContentBytes: 4,
    });
    const readFile = vi.spyOn(fs, 'readFile');

    await fs.writeFile(opened.localPath, 'content larger than four bytes', 'utf8');
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith({
        sessionId: 'oversized-save',
        message: 'Local file content exceeds the configured size limit',
      });
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('routes watcher errors through onError and closes the failed session', async () => {
    const fakeWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    vi.spyOn(nodeFs, 'watch').mockReturnValue(
      fakeWatcher as unknown as ReturnType<typeof nodeFs.watch>,
    );
    const onError = vi.fn();
    const editor = createLocalFileEditor({
      onChange: vi.fn(),
      onError,
      launchApplication: async () => undefined,
    });
    editors.push(editor);
    const opened = await editor.open({
      sessionId: 'watcher-error',
      applicationPath: process.execPath,
      fileName: 'notes.txt',
      content: '',
    });

    fakeWatcher.emit('error', new Error('watch failed'));
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith({
        sessionId: 'watcher-error',
        message: 'Local file watcher failed: watch failed',
        closed: true,
      });
    });
    await vi.waitFor(async () => {
      await expect(fs.access(opened.localPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('bounds the read when the file grows after the stat check', async () => {
    const onError = vi.fn();
    const editor = createLocalFileEditor({
      onChange: vi.fn(),
      onError,
      watchDelayMs: 5,
      launchApplication: async () => undefined,
    });
    editors.push(editor);
    const opened = await editor.open({
      sessionId: 'growing-save',
      applicationPath: process.execPath,
      fileName: 'notes.txt',
      content: '',
      maxContentBytes: 64,
    });
    const stat = vi.spyOn(fs, 'stat').mockResolvedValueOnce({ size: 1 } as Stats);

    await fs.writeFile(opened.localPath, 'x'.repeat(65));
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith({
        sessionId: 'growing-save',
        message: 'Local file content exceeds the configured size limit',
      });
    });

    stat.mockRestore();
  });

  it('rejects an open that races with a watcher failure and reports terminal closure', async () => {
    const fakeWatcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
    fakeWatcher.close = vi.fn();
    let watchedDirectory = '';
    vi.spyOn(nodeFs, 'watch').mockImplementation(((directory: PathLike) => {
      watchedDirectory = directory.toString();
      return fakeWatcher;
    }) as unknown as typeof nodeFs.watch);
    let finishLaunch: (() => void) | undefined;
    const launchApplication = vi.fn(
      () => new Promise<void>((resolve) => {
        finishLaunch = resolve;
      }),
    );
    const onClosed = vi.fn();
    const editor = createLocalFileEditor({
      onChange: vi.fn(),
      onError: vi.fn(),
      onClosed,
      launchApplication,
    });
    editors.push(editor);

    const opening = editor.open({
      sessionId: 'watcher-open-race',
      applicationPath: process.execPath,
      fileName: 'notes.txt',
      content: 'original',
    });
    await vi.waitFor(() => expect(launchApplication).toHaveBeenCalledOnce());
    fakeWatcher.emit('error', new Error('watch failed'));
    finishLaunch?.();

    await expect(opening).rejects.toThrow('Local file session closed during opening');
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledWith('watcher-open-race'));
    await expect(fs.access(watchedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
