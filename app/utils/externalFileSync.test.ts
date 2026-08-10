import { describe, expect, it, vi } from 'vitest';

import { persistExternalFileChange } from './externalFileSync';

describe('external file synchronization', () => {
  it('writes an application save when the backend still matches the opened version', async () => {
    const target = { baseContent: 'before' };
    const write = vi.fn().mockResolvedValue(undefined);
    const onPersisted = vi.fn().mockResolvedValue(undefined);

    const result = await persistExternalFileChange(target, 'after', {
      readLatest: vi.fn().mockResolvedValue('before'),
      write,
      onPersisted,
    });

    expect(result).toBe('saved');
    expect(write).toHaveBeenCalledWith('after');
    expect(target.baseContent).toBe('after');
    expect(onPersisted).toHaveBeenCalledOnce();
  });

  it('rejects an application save when the backend changed independently', async () => {
    const target = { baseContent: 'opened' };
    const write = vi.fn();

    const result = await persistExternalFileChange(target, 'external-app', {
      readLatest: vi.fn().mockResolvedValue('other-client'),
      write,
      onPersisted: vi.fn(),
    });

    expect(result).toBe('conflict');
    expect(write).not.toHaveBeenCalled();
    expect(target.baseContent).toBe('opened');
  });

  it('ignores duplicate file watcher notifications', async () => {
    const target = { baseContent: 'same' };
    const readLatest = vi.fn();

    const result = await persistExternalFileChange(target, 'same', {
      readLatest,
      write: vi.fn(),
      onPersisted: vi.fn(),
    });

    expect(result).toBe('unchanged');
    expect(readLatest).not.toHaveBeenCalled();
  });

  it('reports a saved file separately from a failed refresh and retries that refresh', async () => {
    const target = { baseContent: 'before' };
    const write = vi.fn().mockResolvedValue(undefined);
    const onPersisted = vi
      .fn()
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValue(undefined);
    const dependencies = {
      readLatest: vi.fn().mockResolvedValue('before'),
      write,
      onPersisted,
    };

    await expect(persistExternalFileChange(target, 'after', dependencies)).resolves.toBe(
      'saved-refresh-failed',
    );
    expect(target).toEqual({ baseContent: 'after', refreshPending: true });
    expect(write).toHaveBeenCalledOnce();

    await expect(persistExternalFileChange(target, 'after', dependencies)).resolves.toBe('saved');
    expect(target).toEqual({ baseContent: 'after', refreshPending: false });
    expect(write).toHaveBeenCalledOnce();
    expect(onPersisted).toHaveBeenCalledTimes(2);
  });
});
