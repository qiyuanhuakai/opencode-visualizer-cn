import { describe, expect, it, vi } from 'vitest';
import { resumeOutputFollowing } from './resumeOutputFollowing';

describe('resumeOutputFollowing', () => {
  it('enables following before scrolling the output panel to its newest window', async () => {
    const calls: string[] = [];
    const pauseTracking = vi.fn(() => calls.push('pause'));
    const enableFollow = vi.fn(() => calls.push('enable'));
    const scrollToBottom = vi.fn(async () => {
      calls.push('scroll');
    });
    const resumeTracking = vi.fn(() => calls.push('resume'));

    await resumeOutputFollowing({
      pauseTracking,
      enableFollow,
      scrollToBottom,
      resumeTracking,
    });

    expect(calls).toEqual(['pause', 'enable', 'scroll', 'resume']);
    expect(scrollToBottom).toHaveBeenCalledOnce();
    expect(resumeTracking).toHaveBeenCalledWith({ syncToBottom: true });
  });

  it('restores tracking when scrolling the newest window fails', async () => {
    const resumeTracking = vi.fn();

    await expect(
      resumeOutputFollowing({
        pauseTracking: vi.fn(),
        enableFollow: vi.fn(),
        scrollToBottom: vi.fn().mockRejectedValue(new Error('scroll failed')),
        resumeTracking,
      }),
    ).rejects.toThrow('scroll failed');
    expect(resumeTracking).toHaveBeenCalledWith({ syncToBottom: true });
  });
});
