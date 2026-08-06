import { describe, expect, it } from 'vitest';
import type { ThemedToken } from 'shiki';
import {
  createLanguageCacheState,
  createThemedHighlighter,
  resolveLanguage,
} from './highlightShared';
import { StreamSessionManager } from './streamSession';

const THEME = 'github-dark';

type ComparableToken = {
  content: string;
  color: string | undefined;
  fontStyle: number;
};

function toComparable(token: ThemedToken): ComparableToken {
  return { content: token.content, color: token.color, fontStyle: token.fontStyle ?? 0 };
}

/** Drop newline-only tokens, then project to the comparable shape. */
function comparable(tokens: readonly ThemedToken[]): ComparableToken[] {
  return tokens.filter((t) => t.content !== '\n').map(toComparable);
}

async function oneShotTokens(
  code: string,
  lang: string,
  theme: string,
): Promise<ComparableToken[]> {
  const highlighter = await createThemedHighlighter(theme);
  const state = createLanguageCacheState();
  const resolvedLang = await resolveLanguage(highlighter, lang, state);
  // The web-bundle highlighter narrows lang to BundledLanguage; resolveLanguage
  // already guarantees the string names a loaded grammar (or 'text').
  const result = highlighter.codeToTokens(code, { lang: resolvedLang as never, theme });
  return comparable(result.tokens.flat());
}

async function streamAll(
  manager: StreamSessionManager,
  streamId: string,
  lang: string,
  theme: string,
  chunks: string[],
): Promise<{ cumulative: ThemedToken[]; perStep: ThemedToken[][] }> {
  const opened = await manager.open(streamId, lang, theme);
  expect(opened.ok).toBe(true);
  const perStep: ThemedToken[][] = [];
  let cumulative: ThemedToken[] = [];
  for (const chunk of chunks) {
    const res = await manager.enqueue(streamId, chunk);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    cumulative = [...cumulative, ...res.stable];
    perStep.push(cumulative);
  }
  const closed = manager.close(streamId);
  expect(closed.ok).toBe(true);
  if (!closed.ok) throw new Error(closed.error);
  cumulative = [...cumulative, ...closed.stable];
  return { cumulative, perStep };
}

describe('StreamSessionManager', () => {
  it('streams typescript tokens as strict prefix-extensions and matches one-shot at close', async () => {
    // Given: a realistic TS snippet split into 8 chunks with mid-line splits
    // (including inside a multi-line template literal); every chunk completes
    // at least one line so each enqueue yields new stable tokens.
    const chunks = [
      'const greet = (name: string): string => {\n  const msg = `Hel',
      'lo,\n${nam',
      'e}!\nWelcome back.`;\n  return msg.tri',
      'm();\n};\nconst ou',
      "t = greet('world');\nconsole.lo",
      'g(out);\nout.spl',
      "it('').forEach((ch) => ch);\nexport def",
      'ault greet;\n',
    ];
    const fullCode = chunks.join('');
    const manager = new StreamSessionManager();

    // When: chunks are enqueued one by one
    const opened = await manager.open('ts-stream', 'typescript', THEME);
    expect(opened.ok).toBe(true);

    let cumulative: ThemedToken[] = [];
    for (const chunk of chunks) {
      const res = await manager.enqueue('ts-stream', chunk);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(res.error);
      const next = [...cumulative, ...res.stable];
      // Then: the new cumulative stable tokens are a strict prefix-extension
      // of the previous cumulative stable tokens (never mutated, only grown).
      expect(next.length).toBeGreaterThan(cumulative.length);
      for (let i = 0; i < cumulative.length; i++) {
        expect(toComparable(next[i])).toEqual(toComparable(cumulative[i]));
      }
      cumulative = next;
    }

    const closed = manager.close('ts-stream');
    expect(closed.ok).toBe(true);
    if (!closed.ok) throw new Error(closed.error);
    cumulative = [...cumulative, ...closed.stable];

    // Then: final streamed stable tokens equal one-shot codeToTokens output.
    const oneShot = await oneShotTokens(fullCode, 'typescript', THEME);
    expect(oneShot.length).toBeGreaterThan(0);
    expect(comparable(cumulative)).toEqual(oneShot);
  });

  it('streams custom grammar (fasta) tokens matching one-shot output', async () => {
    // Given: a fasta snippet streamed in arbitrary (mid-line) chunks
    const chunks = ['>seq1 desc', 'ription\nACGTAC', 'GTACGT\n>seq2\nTTGG', 'CCAA\n'];
    const fullCode = chunks.join('');
    const manager = new StreamSessionManager();

    // When: the session is streamed to completion
    const { cumulative } = await streamAll(manager, 'fasta-stream', 'fasta', THEME, chunks);

    // Then: streamed stable tokens equal one-shot tokens for the custom grammar
    const oneShot = await oneShotTokens(fullCode, 'fasta', THEME);
    expect(oneShot.length).toBeGreaterThan(0);
    expect(comparable(cumulative)).toEqual(oneShot);
  });

  it('keeps two interleaved streams (different langs) isolated', async () => {
    // Given: two sessions with different languages, enqueued interleaved
    const manager = new StreamSessionManager();
    const tsChunks = ['const add = (a: number', ', b: number) => a + b;\nconsole.lo', 'g(add(1, 2));\n'];
    const pyChunks = ['def add(a', ', b):\n    return a + b\n\nres', 'ult = add(1, 2)\n'];
    expect((await manager.open('ts-a', 'typescript', THEME)).ok).toBe(true);
    expect((await manager.open('py-b', 'python', THEME)).ok).toBe(true);

    // When: chunks alternate between the two streams
    let tsCumulative: ThemedToken[] = [];
    let pyCumulative: ThemedToken[] = [];
    for (let i = 0; i < Math.max(tsChunks.length, pyChunks.length); i++) {
      if (i < tsChunks.length) {
        const res = await manager.enqueue('ts-a', tsChunks[i]);
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error(res.error);
        tsCumulative = [...tsCumulative, ...res.stable];
      }
      if (i < pyChunks.length) {
        const res = await manager.enqueue('py-b', pyChunks[i]);
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error(res.error);
        pyCumulative = [...pyCumulative, ...res.stable];
      }
    }
    const tsClosed = manager.close('ts-a');
    const pyClosed = manager.close('py-b');
    expect(tsClosed.ok).toBe(true);
    expect(pyClosed.ok).toBe(true);
    if (!tsClosed.ok || !pyClosed.ok) throw new Error('close failed');
    tsCumulative = [...tsCumulative, ...tsClosed.stable];
    pyCumulative = [...pyCumulative, ...pyClosed.stable];

    // Then: each stream matches its own one-shot tokenization (no bleed)
    const tsOneShot = await oneShotTokens(tsChunks.join(''), 'typescript', THEME);
    const pyOneShot = await oneShotTokens(pyChunks.join(''), 'python', THEME);
    expect(tsOneShot.length).toBeGreaterThan(0);
    expect(pyOneShot.length).toBeGreaterThan(0);
    expect(comparable(tsCumulative)).toEqual(tsOneShot);
    expect(comparable(pyCumulative)).toEqual(pyOneShot);
  });

  it('disposes the old session when lang changes for an existing streamId', async () => {
    // Given: a stream that starts as typescript and buffers one line
    const manager = new StreamSessionManager();
    expect((await manager.open('reuse-id', 'typescript', THEME)).ok).toBe(true);
    const first = await manager.enqueue('reuse-id', 'const a = 1;\n');
    expect(first.ok).toBe(true);

    // When: the same streamId is opened with a different language
    const reopened = await manager.open('reuse-id', 'python', THEME);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.reused).toBe(false);
    const second = await manager.enqueue('reuse-id', 'x = 2\n');
    expect(second.ok).toBe(true);

    // Then: the old tokenizer is gone — tokens match a fresh python session
    // containing only the post-reopen chunk.
    const closed = manager.close('reuse-id');
    expect(closed.ok).toBe(true);
    if (!closed.ok || !second.ok) throw new Error('stream failed');
    const streamed = [...second.stable, ...closed.stable];
    const oneShot = await oneShotTokens('x = 2\n', 'python', THEME);
    expect(oneShot.length).toBeGreaterThan(0);
    expect(comparable(streamed)).toEqual(oneShot);
  });

  it('disposes the old session when theme changes for an existing streamId', async () => {
    // Given: a stream under github-dark with one buffered line
    const manager = new StreamSessionManager();
    expect((await manager.open('theme-id', 'typescript', 'github-dark')).ok).toBe(true);
    const first = await manager.enqueue('theme-id', 'const a = 1;\n');
    expect(first.ok).toBe(true);

    // When: the same streamId is reopened under a different theme
    const reopened = await manager.open('theme-id', 'typescript', 'github-light');
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.reused).toBe(false);
    const second = await manager.enqueue('theme-id', 'const b = 2;\n');
    expect(second.ok).toBe(true);
    const closed = manager.close('theme-id');
    expect(closed.ok).toBe(true);
    if (!closed.ok || !second.ok) throw new Error('stream failed');

    // Then: tokens match a fresh github-light session of only the new chunk
    const streamed = [...second.stable, ...closed.stable];
    const oneShot = await oneShotTokens('const b = 2;\n', 'typescript', 'github-light');
    expect(oneShot.length).toBeGreaterThan(0);
    expect(comparable(streamed)).toEqual(oneShot);
  });

  it('cancel removes the session; subsequent enqueue returns an error result', async () => {
    // Given: an open session
    const manager = new StreamSessionManager();
    expect((await manager.open('cancel-id', 'typescript', THEME)).ok).toBe(true);
    const res = await manager.enqueue('cancel-id', 'const a = 1;\n');
    expect(res.ok).toBe(true);

    // When: the session is cancelled
    manager.cancel('cancel-id');

    // Then: the session is gone and further operations report errors
    expect(manager.has('cancel-id')).toBe(false);
    const after = await manager.enqueue('cancel-id', 'const b = 2;\n');
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error).toContain('cancel-id');
    const closed = manager.close('cancel-id');
    expect(closed.ok).toBe(false);

    // And: cancelling an unknown id is a no-op
    expect(() => manager.cancel('never-existed')).not.toThrow();
  });
});
