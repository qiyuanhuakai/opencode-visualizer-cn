import { ShikiStreamTokenizer } from '@shikijs/stream';
import type { ThemedToken } from 'shiki';
import {
  createLanguageCacheState,
  createThemedHighlighter,
  resolveLanguage,
  type Highlighter,
  type LanguageCacheState,
} from './highlightShared';

type StreamSession = {
  tokenizer: ShikiStreamTokenizer;
  lang: string;
  theme: string;
};

export type StreamOpenResult = { ok: true; reused: boolean } | { ok: false; error: string };

export type StreamEnqueueResult =
  | { ok: true; recall: number; stable: ThemedToken[]; unstable: ThemedToken[] }
  | { ok: false; error: string };

export type StreamCloseResult = { ok: true; stable: ThemedToken[] } | { ok: false; error: string };

/**
 * Manages incremental highlight sessions over ShikiStreamTokenizer, keyed by
 * streamId. Sessions are opened explicitly; enqueue/close on an unknown id
 * (never opened, closed, or cancelled) returns an error result instead of
 * throwing. Re-opening an existing id with a different lang or theme disposes
 * the old tokenizer and starts a fresh session.
 */
export class StreamSessionManager {
  private sessions = new Map<string, StreamSession>();
  private highlighters = new Map<string, Promise<Highlighter>>();
  private languageStates = new Map<string, LanguageCacheState>();

  private getHighlighter(theme: string) {
    let highlighter = this.highlighters.get(theme);
    if (!highlighter) {
      highlighter = createThemedHighlighter(theme);
      this.highlighters.set(theme, highlighter);
      this.languageStates.set(theme, createLanguageCacheState());
    }
    return highlighter;
  }

  has(streamId: string) {
    return this.sessions.has(streamId);
  }

  async open(streamId: string, lang: string, theme: string): Promise<StreamOpenResult> {
    const existing = this.sessions.get(streamId);
    if (existing && existing.lang === lang && existing.theme === theme) {
      return { ok: true, reused: true };
    }
    if (existing) this.sessions.delete(streamId);
    const highlighter = await this.getHighlighter(theme);
    const state = this.languageStates.get(theme) ?? createLanguageCacheState();
    const resolvedLang = await resolveLanguage(highlighter, lang, state);
    const tokenizer = new ShikiStreamTokenizer({ highlighter, lang: resolvedLang, theme });
    this.sessions.set(streamId, { tokenizer, lang, theme });
    return { ok: true, reused: false };
  }

  async enqueue(streamId: string, chunk: string): Promise<StreamEnqueueResult> {
    const session = this.sessions.get(streamId);
    if (!session) {
      return { ok: false, error: `no stream session for id: ${streamId}` };
    }
    const result = await session.tokenizer.enqueue(chunk);
    return { ok: true, recall: result.recall, stable: result.stable, unstable: result.unstable };
  }

  close(streamId: string): StreamCloseResult {
    const session = this.sessions.get(streamId);
    if (!session) {
      return { ok: false, error: `no stream session for id: ${streamId}` };
    }
    this.sessions.delete(streamId);
    const { stable } = session.tokenizer.close();
    return { ok: true, stable };
  }

  cancel(streamId: string): void {
    this.sessions.delete(streamId);
  }
}
