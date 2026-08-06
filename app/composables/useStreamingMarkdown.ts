import {
  getCurrentScope,
  onScopeDispose,
  type Ref,
  type WatchSource,
  watch,
} from 'vue';

import { createMarkdownSegmenter } from '../utils/markdownSegment';
import {
  getMarkdownSegmentHtml,
  setMarkdownSegmentHtml,
} from '../utils/markdownSegmentCache';

export type StreamingMarkdownOptions = {
  readonly text: WatchSource<string>;
  readonly theme: WatchSource<string>;
  readonly enabled: WatchSource<boolean>;
  readonly render: (markdown: string, theme: string) => Promise<string>;
  readonly containerRef: Ref<HTMLElement | null>;
  // Identity of every render-affecting input besides text/theme (files, copy
  // labels). Segment cache entries are keyed by it and a change forces a reset.
  readonly renderContext?: WatchSource<string>;
};

export type StreamingMarkdown = {
  readonly dispose: () => void;
};

type StableRange = {
  readonly start: number;
  readonly end: number;
  readonly markdown: string;
};

type ResolvedBlock = StableRange & {
  readonly html: string;
};

type AppliedBlock = ResolvedBlock & {
  readonly nodes: readonly Node[];
};

type StableRanges = {
  readonly ranges: readonly StableRange[];
  readonly end: number;
};

function getStableRanges(stable: readonly string[], appliedOffset: number): StableRanges {
  const ranges: StableRange[] = [];
  let offset = 0;

  for (const part of stable) {
    const end = offset + part.length;
    if (end > appliedOffset) {
      const start = Math.max(offset, appliedOffset);
      ranges.push({
        start,
        end,
        markdown: part.slice(start - offset),
      });
    }
    offset = end;
  }

  return { ranges, end: offset };
}

export function useStreamingMarkdown(options: StreamingMarkdownOptions): StreamingMarkdown {
  const segmenter = createMarkdownSegmenter();
  let latestText = '';
  let latestTheme = '';
  let latestContext = '';
  let latestEnabled = false;
  let latestContainer: HTMLElement | null = null;
  let latestVersion = 0;
  let loopRunning = false;
  let disposed = false;
  let observed = false;
  let forceReset = true;
  let appliedStableOffset = 0;
  let stableBlocks: AppliedBlock[] = [];
  let tailNodes: Node[] = [];
  let stopWatch: (() => void) | null = null;

  function removeTailNodes(): void {
    for (const node of tailNodes) {
      node.parentNode?.removeChild(node);
    }
    tailNodes = [];
  }

  function clearAppliedState(): void {
    options.containerRef.value?.replaceChildren();
    stableBlocks = [];
    tailNodes = [];
    appliedStableOffset = 0;
  }

  function parseHtml(html: string, container: HTMLElement): Node[] {
    const template = container.ownerDocument.createElement('template');
    template.innerHTML = html;
    return Array.from(template.content.childNodes);
  }

  function applyStableBlocks(blocks: readonly ResolvedBlock[], stableOffset: number): void {
    const container = options.containerRef.value;
    for (const block of blocks) {
      const alreadyApplied = stableBlocks.some(
        (existing) => existing.start === block.start && existing.end === block.end,
      );
      if (alreadyApplied) continue;
      const nodes = container ? parseHtml(block.html, container) : [];
      if (container) {
        const before = tailNodes[0] ?? null;
        for (const node of nodes) {
          container.insertBefore(node, before);
        }
      }
      stableBlocks.push({ ...block, nodes });
    }
    appliedStableOffset = stableOffset;
  }

  function applyTail(html: string): void {
    const container = options.containerRef.value;
    removeTailNodes();
    if (!container) return;
    tailNodes = parseHtml(html, container);
    for (const node of tailNodes) {
      container.append(node);
    }
  }

  function applyFullHtml(html: string): void {
    const container = options.containerRef.value;
    stableBlocks = [];
    appliedStableOffset = 0;
    tailNodes = container ? parseHtml(html, container) : [];
    if (!container) return;
    container.replaceChildren();
    for (const node of tailNodes) {
      container.append(node);
    }
  }

  function isCurrent(version: number, text: string, theme: string, context: string): boolean {
    return (
      !disposed &&
      latestEnabled &&
      latestVersion === version &&
      latestText === text &&
      latestTheme === theme &&
      latestContext === context
    );
  }

  async function resolveStableBlocks(
    ranges: readonly StableRange[],
    theme: string,
    context: string,
  ): Promise<ResolvedBlock[]> {
    const inFlight = new Map<string, Promise<string>>();
    return Promise.all(
      ranges.map(async (range) => {
        const cached = getMarkdownSegmentHtml(theme, context, range.markdown);
        if (cached !== undefined) return { ...range, html: cached };

        const key = `${theme}\n${context}\n${range.markdown}`;
        let htmlPromise = inFlight.get(key);
        if (!htmlPromise) {
          htmlPromise = options.render(range.markdown, theme).then((html) => {
            setMarkdownSegmentHtml(theme, context, range.markdown, html);
            return html;
          });
          inFlight.set(key, htmlPromise);
        }
        return { ...range, html: await htmlPromise };
      }),
    );
  }

  async function runLoop(): Promise<void> {
    if (loopRunning || disposed || !latestEnabled) return;
    loopRunning = true;

    try {
      while (!disposed && latestEnabled) {
        const iterationVersion = latestVersion;
        const text = latestText;
        const theme = latestTheme;
        const context = latestContext;
        const result = segmenter.push(text);
        const stablePrefixLength = result.stable.join('').length;
        const shouldReset = forceReset || result.reset || stablePrefixLength < appliedStableOffset;
        if (shouldReset) clearAppliedState();

        if (result.disabled) {
          const html = await options.render(text, theme);
          if (!isCurrent(iterationVersion, text, theme, context)) continue;
          applyFullHtml(html);
          forceReset = false;
          if (latestVersion === iterationVersion) break;
          continue;
        }

        const { ranges, end } = getStableRanges(result.stable, appliedStableOffset);
        const stableHtmlPromise = resolveStableBlocks(ranges, theme, context);
        const tailHtmlPromise = options.render(result.tail, theme);
        const [resolvedBlocks, tailHtml] = await Promise.all([stableHtmlPromise, tailHtmlPromise]);
        if (!isCurrent(iterationVersion, text, theme, context)) continue;
        applyStableBlocks(resolvedBlocks, end);
        if (appliedStableOffset !== end) continue;
        applyTail(tailHtml);
        forceReset = false;
        if (latestVersion === iterationVersion) break;
      }
    } catch (error) {
      // A failed render ends the iteration cleanly: the last good DOM stays in
      // place and the next watcher tick re-runs the loop with the latest text.
      // No hot retry — a persistently failing render is reported once per change.
      console.error('[useStreamingMarkdown] render failed; keeping last rendered content', error);
    } finally {
      loopRunning = false;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    latestEnabled = false;
    latestVersion += 1;
    stopWatch?.();
    stopWatch = null;
  }

  const contextSource: WatchSource<string> = options.renderContext ?? (() => '');

  stopWatch = watch(
    [options.text, options.theme, contextSource, options.enabled, options.containerRef],
    ([text, theme, context, enabled, container]) => {
      const themeChanged = observed && theme !== latestTheme;
      const contextChanged = observed && context !== latestContext;
      const enabledChanged = observed && enabled !== latestEnabled;
      const containerChanged = observed && container !== latestContainer;
      latestText = text;
      latestTheme = theme;
      latestContext = context;
      latestEnabled = enabled;
      latestContainer = container;
      latestVersion += 1;

      if (themeChanged || contextChanged || (enabledChanged && enabled) || containerChanged)
        forceReset = true;
      observed = true;
      if (enabled) void runLoop();
    },
    { immediate: true },
  );

  if (getCurrentScope()) onScopeDispose(dispose);

  return { dispose };
}
