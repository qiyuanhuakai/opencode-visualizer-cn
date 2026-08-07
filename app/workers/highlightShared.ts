import { bundledLanguages, createHighlighter } from 'shiki/bundle/web';
import { bundledLanguages as allBundledLanguages } from 'shiki/langs';
import fastaGrammarRaw from '../grammars/fasta.tmLanguage.json?raw';
import fastqGrammarRaw from '../grammars/fastq.tmLanguage.json?raw';
import samGrammarRaw from '../grammars/sam.tmLanguage.json?raw';
import vcfGrammarRaw from '../grammars/vcf.tmLanguage.json?raw';
import bedGrammarRaw from '../grammars/bed.tmLanguage.json?raw';
import gtfGrammarRaw from '../grammars/gtf.tmLanguage.json?raw';

export type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

export const customGrammars: Record<string, object> = {
  fasta: { ...JSON.parse(fastaGrammarRaw), name: 'fasta' },
  fastq: { ...JSON.parse(fastqGrammarRaw), name: 'fastq' },
  sam: { ...JSON.parse(samGrammarRaw), name: 'sam' },
  vcf: { ...JSON.parse(vcfGrammarRaw), name: 'vcf' },
  bed: { ...JSON.parse(bedGrammarRaw), name: 'bed' },
  gtf: { ...JSON.parse(gtfGrammarRaw), name: 'gtf' },
};

/**
 * Create a shiki highlighter for a single theme with only the `text` grammar
 * preloaded; real languages are loaded on demand via resolveLanguage.
 */
export function createThemedHighlighter(theme: string) {
  return createHighlighter({ themes: [theme], langs: ['text'] });
}

/**
 * Per-highlighter language bookkeeping. Each highlighter instance must own a
 * fresh state; sharing state across highlighters would confuse "loaded" with
 * "loadable". Reset whenever the underlying highlighter is rebuilt.
 */
export type LanguageCacheState = {
  loaded: Set<string>;
  failed: Set<string>;
};

export function createLanguageCacheState(): LanguageCacheState {
  return { loaded: new Set(['text']), failed: new Set() };
}

export function languageCandidates(lang: string) {
  const trimmed = (lang || '').trim().toLowerCase();
  if (!trimmed) return ['text'];
  if (trimmed === 'shellscript') return ['bash', 'shellscript', 'sh', 'text'];
  if (trimmed === 'tsx') return ['tsx', 'typescript', 'text'];
  if (trimmed === 'jsx') return ['jsx', 'javascript', 'text'];
  if (trimmed === 'md') return ['markdown', 'text'];
  if (trimmed === 'yml') return ['yaml', 'text'];
  return [trimmed, 'text'];
}

export async function resolveLanguage(
  highlighter: Highlighter,
  lang: string,
  state: LanguageCacheState,
) {
  const loaded =
    typeof highlighter.getLoadedLanguages === 'function' ? highlighter.getLoadedLanguages() : [];
  for (const item of loaded) state.loaded.add(item);
  for (const candidate of languageCandidates(lang)) {
    if (state.loaded.has(candidate)) return candidate;
    if (candidate === 'text') return 'text';
    const loadedCandidate = await tryLoadLanguage(highlighter, candidate, state);
    if (loadedCandidate) return candidate;
  }
  return 'text';
}

type LanguageLoader = () => Promise<{ default: unknown }>;

async function tryLoadLanguage(
  highlighter: Highlighter,
  candidate: string,
  state: LanguageCacheState,
) {
  if (state.failed.has(candidate)) return false;
  if (typeof highlighter.loadLanguage !== 'function') return false;

  const customGrammar = customGrammars[candidate];
  if (customGrammar) {
    try {
      await highlighter.loadLanguage(customGrammar as never);
      state.loaded.add(candidate);
      state.failed.delete(candidate);
      return true;
    } catch (error) {
      console.warn('[highlight-shared] custom grammar load failed', candidate, error);
      state.failed.add(candidate);
      return false;
    }
  }

  const loader =
    (bundledLanguages as Record<string, unknown>)[candidate] ??
    (allBundledLanguages as Record<string, unknown>)[candidate];
  try {
    if (typeof loader === 'function') {
      const module = await (loader as LanguageLoader)();
      const language = module?.default;
      await highlighter.loadLanguage(language as never);
    } else {
      await highlighter.loadLanguage(candidate as never);
    }
    state.loaded.add(candidate);
    state.failed.delete(candidate);
    return true;
  } catch (error) {
    if (!state.failed.has(candidate)) {
      console.warn('[highlight-shared] language load failed', candidate, error);
    }
    state.failed.add(candidate);
    return false;
  }
}
