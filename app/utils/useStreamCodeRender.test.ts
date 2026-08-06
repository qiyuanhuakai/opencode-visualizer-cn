/**
 * RED tests for useStreamCodeRender composable.
 *
 * Tests the streaming code render composable with mocked worker stream.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ref, nextTick } from 'vue';
import type { StreamTokenBatch } from '../workers/streamHandler';
import type { RenderWorkerStream } from '../utils/workerStream';

vi.mock('../utils/workerStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/workerStream')>();
  return {
    ...actual,
    startRenderWorkerStream: vi.fn(),
  };
});

vi.mock('../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { startRenderWorkerStream } from '../utils/workerStream';
import { useStreamCodeRender, type StreamCodeRenderParams } from './useStreamCodeRender';

const mockStartStream = vi.mocked(startRenderWorkerStream);

function createMockStream(): {
  stream: RenderWorkerStream;
  sendChunk: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  triggerBatch: (batch: StreamTokenBatch) => void;
} {
  const sendChunk = vi.fn();
  const close = vi.fn().mockResolvedValue('<div class="code-host"><pre class="shiki"><code>final</code></pre></div>');
  const cancel = vi.fn();
  let batchCallback: ((batch: StreamTokenBatch) => void) | null = null;

  const stream: RenderWorkerStream = {
    sendChunk,
    close,
    cancel,
    onBatch: (cb) => {
      batchCallback = cb;
    },
  };

  const triggerBatch = (batch: StreamTokenBatch) => {
    batchCallback?.(batch);
  };

  return { stream, sendChunk, close, cancel, triggerBatch };
}

describe('useStreamCodeRender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a stream when params become non-null', async () => {
    // Given: no initial params
    const params = ref<StreamCodeRenderParams | null>(null);
    const { stream, sendChunk: _sendChunk } = createMockStream();
    mockStartStream.mockReturnValue(stream);

    // When: composable is created
    const { containerRef: _containerRef } = useStreamCodeRender(params);

    // Then: no stream opened yet
    expect(mockStartStream).not.toHaveBeenCalled();

    // When: params are set
    params.value = { code: 'const x = 1;', lang: 'typescript', theme: 'github-dark' };
    await nextTick();

    // Then: stream is opened
    expect(mockStartStream).toHaveBeenCalledWith({
      lang: 'typescript',
      theme: 'github-dark',
      gutterMode: 'none',
    });
  });

  it('sends only the diff suffix when code grows (prefix extension)', async () => {
    // Given: a stream is open with initial code
    const params = ref({ code: 'const x', lang: 'typescript', theme: 'github-dark' });
    const { stream, sendChunk } = createMockStream();
    mockStartStream.mockReturnValue(stream);

    const { containerRef: _containerRef } = useStreamCodeRender(params);
    await nextTick();

    // Then: initial code is sent on open
    expect(sendChunk).toHaveBeenCalledWith('const x');

    // When: code grows by appending
    params.value = { code: 'const x = 1;', lang: 'typescript', theme: 'github-dark' };
    await nextTick();

    // Then: only the suffix " = 1;" is sent (not the full code)
    expect(sendChunk).toHaveBeenCalledWith(' = 1;');
    expect(sendChunk).toHaveBeenCalledTimes(2);
  });

  it('cancels and reopens when code shrinks or is replaced (not a prefix extension)', async () => {
    // Given: a stream is open
    const params = ref({ code: 'const x = 1;', lang: 'typescript', theme: 'github-dark' });
    const { stream: stream1, sendChunk: _sendChunk1, cancel: cancel1 } = createMockStream();
    const { stream: stream2, sendChunk: sendChunk2 } = createMockStream();
    mockStartStream.mockReturnValueOnce(stream1).mockReturnValueOnce(stream2);

    const { containerRef: _containerRef } = useStreamCodeRender(params);
    await nextTick();

    // When: code is replaced (not a prefix extension)
    params.value = { code: 'let y = 2;', lang: 'typescript', theme: 'github-dark' };
    await nextTick();

    // Then: old stream is cancelled, new stream is opened
    expect(cancel1).toHaveBeenCalled();
    expect(mockStartStream).toHaveBeenCalledTimes(2);
    expect(sendChunk2).toHaveBeenCalledWith('let y = 2;');
  });

  it('cancels and reopens when lang or theme changes', async () => {
    // Given: a stream is open
    const params = ref({ code: 'const x = 1;', lang: 'typescript', theme: 'github-dark' });
    const { stream: stream1, cancel: cancel1 } = createMockStream();
    const { stream: stream2 } = createMockStream();
    mockStartStream.mockReturnValueOnce(stream1).mockReturnValueOnce(stream2);

    const { containerRef: _containerRef } = useStreamCodeRender(params);
    await nextTick();

    // When: theme changes
    params.value = { code: 'const x = 1;', lang: 'typescript', theme: 'github-light' };
    await nextTick();

    // Then: old stream is cancelled, new stream is opened with new theme
    expect(cancel1).toHaveBeenCalled();
    expect(mockStartStream).toHaveBeenLastCalledWith({
      lang: 'typescript',
      theme: 'github-light',
      gutterMode: 'none',
    });
  });

  it('applies batches to the container via streamPatch', async () => {
    // Given: a stream is open with a container
    const params = ref({ code: 'line1\nline2', lang: 'typescript', theme: 'github-dark' });
    const { stream, triggerBatch } = createMockStream();
    mockStartStream.mockReturnValue(stream);

    const { containerRef } = useStreamCodeRender(params);
    await nextTick();

    // Create a real container element
    const container = document.createElement('div');
    containerRef.value = container;

    // When: a batch arrives with stable lines
    triggerBatch({
      recall: 0,
      stable: [
        { content: 'line1', offset: 0, color: '#E1E4E8' },
        { content: '\n', offset: 0 },
      ],
      unstable: [{ content: 'line2', offset: 0, color: '#E1E4E8' }],
    });

    // Then: container has the rows
    expect(container.querySelector('.code-row')).not.toBeNull();
    expect(container.innerHTML).toContain('line1');
    expect(container.innerHTML).toContain('line2');
  });

  it('clears stale rows from the container when cancel+reopen happens', async () => {
    // Given: a stream is open and has painted rows for theme A
    const params = ref({ code: 'line1\nline2', lang: 'typescript', theme: 'github-dark' });
    const { stream: stream1, triggerBatch: triggerBatch1 } = createMockStream();
    const { stream: stream2 } = createMockStream();
    mockStartStream.mockReturnValueOnce(stream1).mockReturnValueOnce(stream2);

    const { containerRef } = useStreamCodeRender(params);
    await nextTick();

    const container = document.createElement('div');
    containerRef.value = container;

    triggerBatch1({
      recall: 0,
      stable: [
        { content: 'line1', offset: 0, color: '#E1E4E8' },
        { content: '\n', offset: 0 },
      ],
      unstable: [{ content: 'line2', offset: 0, color: '#E1E4E8' }],
    });
    expect(container.querySelectorAll('.code-row').length).toBeGreaterThan(0);

    // When: theme changes (cancel + reopen with a fresh stream)
    params.value = { code: 'line1\nline2', lang: 'typescript', theme: 'dark-plus' };
    await nextTick();

    // Then: rows from the cancelled session must not linger in the container
    expect(container.querySelectorAll('.code-row').length).toBe(0);
  });

  it('finalizes with converged HTML when stream closes', async () => {
    // Given: a stream is open
    const params = ref({ code: 'const x = 1;', lang: 'typescript', theme: 'github-dark' });
    const finalHtml = '<div class="code-host"><pre class="shiki"><code>final</code></pre></div>';
    const { stream, close } = createMockStream();
    close.mockResolvedValue(finalHtml);
    mockStartStream.mockReturnValue(stream);

    const { containerRef, html, done } = useStreamCodeRender(params);
    const container = document.createElement('div');
    containerRef.value = container;
    await nextTick();

    // When: code stops changing (debounce triggers close)
    await vi.advanceTimersByTimeAsync(500);

    // Then: close is called, html is set, done is true
    expect(close).toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(html.value).toBe(finalHtml);
    expect(done.value).toBe(true);
    expect(container.innerHTML).toBe(finalHtml);
  });

  it('cancels stream on unmount', async () => {
    // Given: a stream is open
    const params = ref({ code: 'const x = 1;', lang: 'typescript', theme: 'github-dark' });
    const { stream, cancel } = createMockStream();
    mockStartStream.mockReturnValue(stream);

    const { containerRef: _containerRef, unmount } = useStreamCodeRender(params);
    await nextTick();

    // When: unmount is called
    unmount();

    // Then: stream is cancelled
    expect(cancel).toHaveBeenCalled();
  });

  it('sets error ref when close() rejects', async () => {
    // Given: a stream that will fail on close
    const params = ref({ code: 'const x = 1;', lang: 'typescript', theme: 'github-dark' });
    const { stream, close } = createMockStream();
    close.mockRejectedValue(new Error('Worker failed'));
    mockStartStream.mockReturnValue(stream);

    const { containerRef, error } = useStreamCodeRender(params);
    const container = document.createElement('div');
    containerRef.value = container;
    await nextTick();

    // When: debounce triggers close
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();

    // Then: error is set
    expect(error.value).toContain('Worker failed');
  });

  it('does nothing when params are null', async () => {
    // Given: null params
    const params = ref(null);

    const { containerRef: _containerRef, html, done } = useStreamCodeRender(params);
    await nextTick();

    // Then: no stream opened, html is empty, done is false
    expect(mockStartStream).not.toHaveBeenCalled();
    expect(html.value).toBe('');
    expect(done.value).toBe(false);
  });
});
