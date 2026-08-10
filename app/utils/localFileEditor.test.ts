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
});
