import { reactive, computed, markRaw, onUnmounted, type Component } from 'vue';
import { renderWorkerHtml } from '../utils/workerRenderer';

export interface FloatingWindowEntry {
  key: string;
  component?: Component;
  props?: Record<string, unknown>;
  content?: string | (() => Promise<string>);
  lang?: string;
  title?: string;
  status?: 'running' | 'completed' | 'error';
  resolvedHtml: string;
  isReady: boolean;
  variant?: 'code' | 'diff' | 'message' | 'binary' | 'term' | 'plain';
  lineOffset?: number;
  lineLimit?: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  zIndex: number;
  closable: boolean;
  resizable: boolean;
  scroll: 'follow' | 'force' | 'manual' | 'none';
  smoothEngine?: 'raf' | 'native';
  focusOnOpen?: boolean;
  color?: string;
  time: number;
  expiry?: number;
  expiresAt: number;
  beforeOpen?: () => Promise<void>;
  afterOpen?: (el: HTMLElement) => void;
  beforeClose?: (el: HTMLElement) => Promise<void>;
  afterClose?: () => void;
  onResize?: (width: number, height: number) => void;
}

export type Extent = { width: number; height: number };

const TOOL_RUNNING_TTL_MS = 1000 * 60 * 10;
const TOOL_COMPLETED_TTL_MS = 2000;
const TITLEBAR_VISIBLE_PX = 32;

const DEFAULT_OPTS: Partial<FloatingWindowEntry> = {
  closable: false,
  resizable: false,
  scroll: 'force',
  width: 600,
  height: 400,
};

let renderIdCounter = 0;
function nextRenderId(): string {
  return `fw-${++renderIdCounter}-${Date.now().toString(36)}`;
}

function resolveEntryClosable(
  opts: Partial<FloatingWindowEntry>,
  existing?: FloatingWindowEntry,
): boolean {
  if (typeof opts.closable === 'boolean') return opts.closable;
  if (typeof existing?.closable === 'boolean') return existing.closable;
  if (typeof DEFAULT_OPTS.closable === 'boolean') return DEFAULT_OPTS.closable;
  return false;
}

const MANUAL_ZINDEX_OFFSET = 10000;

let zIndexCounter = 100;

function isManualTier(key: string, closable?: boolean): boolean {
  if (closable) return true;
  return key.startsWith('permission:') || key.startsWith('question:');
}

function nextZIndex(manualTier: boolean): number {
  return ++zIndexCounter + (manualTier ? MANUAL_ZINDEX_OFFSET : 0);
}

function getAxisBounds(extentSize: number, windowSize: number, visibleSize: number) {
  const keepVisible = Math.max(1, Math.min(visibleSize, windowSize, extentSize));
  return {
    min: keepVisible - windowSize,
    max: extentSize - keepVisible,
  };
}

function variantToGutterMode(variant?: string): 'none' | 'single' | 'double' {
  switch (variant) {
    case 'diff':
      return 'double';
    case 'code':
      return 'single';
    default:
      return 'none';
  }
}

/**
 * Prevent Vue's reactive() from deeply proxying non-serializable values.
 * Proxied components break <component :is>, and proxied functions are wasteful.
 */
function sanitizeEntry(entry: FloatingWindowEntry): FloatingWindowEntry {
  if (entry.component) entry.component = markRaw(entry.component);
  if (entry.beforeOpen) entry.beforeOpen = markRaw(entry.beforeOpen);
  if (entry.afterOpen) entry.afterOpen = markRaw(entry.afterOpen);
  if (entry.beforeClose) entry.beforeClose = markRaw(entry.beforeClose);
  if (entry.afterClose) entry.afterClose = markRaw(entry.afterClose);
  if (entry.onResize) entry.onResize = markRaw(entry.onResize);
  return entry;
}

function resolveExpiresAt(
  opts: Partial<FloatingWindowEntry>,
  existing?: FloatingWindowEntry,
): number {
  // Explicit expiresAt always wins
  if (typeof opts.expiresAt === 'number') return opts.expiresAt;
  // expiry: Infinity → permanent, expiry: N → N ms from now
  if (typeof opts.expiry === 'number') {
    return opts.expiry === Infinity ? Number.MAX_SAFE_INTEGER : Date.now() + opts.expiry;
  }
  // Status-based: completed/error always gets short TTL (even if existing had longer)
  const status = opts.status;
  if (status === 'completed' || status === 'error') return Date.now() + TOOL_COMPLETED_TTL_MS;
  // For non-terminal status, keep existing expiry if set
  if (existing && typeof existing.expiresAt === 'number') return existing.expiresAt;
  return Date.now() + TOOL_RUNNING_TTL_MS;
}

export function useFloatingWindows() {
  const entriesMap = reactive(new Map<string, FloatingWindowEntry>());
  const entries = computed(() => [...entriesMap.values()].filter((e) => e.isReady));
  let extent: Extent = {
    width: typeof window !== 'undefined' ? window.innerWidth : 1920,
    height: typeof window !== 'undefined' ? window.innerHeight : 1080,
  };

  function setExtent(w: number, h: number) {
    extent = { width: w, height: h };
  }

  function getExtent(): Extent {
    return extent;
  }

  function getRandomPosition(targetWidth = 600, targetHeight = 400): { x: number; y: number } {
    const padding = 20;
    const maxX = Math.max(0, extent.width - targetWidth - padding);
    const maxY = Math.max(0, extent.height - targetHeight - padding);
    return {
      x: padding + Math.floor(Math.random() * maxX),
      y: padding + Math.floor(Math.random() * maxY),
    };
  }

  // Per-window expiry timers
  const timerMap = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleExpiry(key: string, expiresAt: number): void {
    // Skip scheduling for permanent windows
    if (expiresAt >= Number.MAX_SAFE_INTEGER) return;

    // Clear existing timer if present
    const existingTimer = timerMap.get(key);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }

    const delay = Math.max(0, expiresAt - Date.now());
    const timerId = setTimeout(() => {
      timerMap.delete(key);
      close(key);
    }, delay);
    timerMap.set(key, timerId);
  }

  onUnmounted(() => {
    for (const timerId of timerMap.values()) {
      clearTimeout(timerId);
    }
    timerMap.clear();
  });

  async function open(key: string, opts: Partial<FloatingWindowEntry>): Promise<void> {
    const existing = entriesMap.get(key);

    // Merge with defaults and existing
    const merged: FloatingWindowEntry = {
      ...DEFAULT_OPTS,
      ...existing,
      ...opts,
      key,
      time: Date.now(),
      zIndex: existing
        ? existing.zIndex
        : nextZIndex(isManualTier(key, resolveEntryClosable(opts, existing))),
    } as FloatingWindowEntry;

    // When updating an existing entry, merge props instead of replacing
    if (existing && existing.props && opts.props) {
      merged.props = { ...existing.props, ...opts.props };
    }

    // Set initial position if new and no explicit x/y provided
    if (!existing && opts.x == null && opts.y == null) {
      const pos = getRandomPosition(merged.width ?? 600, merged.height ?? 400);
      merged.x = pos.x;
      merged.y = pos.y;
    }

    // Clamp position to visible bounds
    const windowWidth = merged.width ?? 600;
    const xBounds = getAxisBounds(extent.width, windowWidth, TITLEBAR_VISIBLE_PX);
    const keepVisibleY = Math.max(1, Math.min(TITLEBAR_VISIBLE_PX, extent.height));
    merged.x = Math.max(xBounds.min, Math.min(merged.x, xBounds.max));
    merged.y = Math.max(0, Math.min(merged.y, extent.height - keepVisibleY));

    // Execute beforeOpen hook
    if (merged.beforeOpen) {
      await merged.beforeOpen();
    }

    // Content resolution
    if (typeof merged.content === 'function') {
      try {
        merged.resolvedHtml = await (merged.content as () => Promise<string>)();
        merged.isReady = true;
      } catch (e) {
        merged.resolvedHtml = String(e);
        merged.isReady = true;
      }
    } else if (merged.content && merged.lang) {
      try {
        merged.resolvedHtml = await renderWorkerHtml({
          id: nextRenderId(),
          code: merged.content,
          lang: merged.lang,
          theme: 'github-dark',
          gutterMode: variantToGutterMode(merged.variant),
          lineOffset: merged.lineOffset,
          lineLimit: merged.lineLimit,
        });
        merged.isReady = true;
      } catch {
        merged.resolvedHtml = `<pre>${merged.content}</pre>`;
        merged.isReady = true;
      }
    } else if (merged.content) {
      merged.resolvedHtml = merged.content;
      merged.isReady = true;
    } else {
      // No content — component handles display
      merged.resolvedHtml = '';
      merged.isReady = true;
    }

    // expiresAt must be computed after content resolution (not in the merge block above)
    // so the TTL countdown starts from display-ready, not before async work.
    merged.expiresAt = resolveExpiresAt(opts, existing);

    const shouldFocusOnOpen = !existing && merged.focusOnOpen === true;

    entriesMap.set(key, sanitizeEntry(merged));

    scheduleExpiry(key, merged.expiresAt);

    // Execute afterOpen hook
    if (merged.afterOpen) {
      setTimeout(() => {
        const el = document.querySelector(`[data-floating-key="${key}"]`);
        if (el) merged.afterOpen!(el as HTMLElement);
      }, 0);
    }

    if (shouldFocusOnOpen) {
      setTimeout(() => {
        const body = document.querySelector(
          `[data-floating-key="${key}"] .floating-window-body`,
        ) as HTMLElement | null;
        if (!body) return;
        body.focus();
      }, 0);
    }
  }

  function updateOptions(key: string, partialOpts: Partial<FloatingWindowEntry>): void {
    const existing = entriesMap.get(key);
    if (!existing) return;

    const merged = {
      ...existing,
      ...partialOpts,
      key,
    } as FloatingWindowEntry;

    // Status-based expiry
    if (partialOpts.status && !partialOpts.expiresAt) {
      if (partialOpts.status === 'completed' || partialOpts.status === 'error') {
        merged.expiresAt = Date.now() + TOOL_COMPLETED_TTL_MS;
      }
    }

    entriesMap.set(key, sanitizeEntry(merged));

    if (partialOpts.status === 'completed' || partialOpts.status === 'error') {
      scheduleExpiry(key, merged.expiresAt);
    }
  }

  async function setContent(key: string, text: string, lang?: string): Promise<void> {
    const entry = entriesMap.get(key);
    if (!entry) return;

    entry.content = text;
    entry.lang = lang;

    if (lang) {
      entry.resolvedHtml = await renderWorkerHtml({
        id: nextRenderId(),
        code: text,
        lang,
        theme: 'github-dark',
        gutterMode: variantToGutterMode(entry.variant),
      });
    } else {
      entry.resolvedHtml = text;
    }
  }

  async function appendContent(key: string, text: string, lang?: string): Promise<void> {
    const entry = entriesMap.get(key);
    if (!entry) return;

    const newContent = (entry.content || '') + text;
    entry.content = newContent;

    if (lang || entry.lang) {
      entry.resolvedHtml = await renderWorkerHtml({
        id: nextRenderId(),
        code: newContent,
        lang: lang || entry.lang!,
        theme: 'github-dark',
        gutterMode: variantToGutterMode(entry.variant),
      });
    } else {
      entry.resolvedHtml = newContent;
    }
  }

  function setTitle(key: string, title: string): void {
    const entry = entriesMap.get(key);
    if (entry) entry.title = title;
  }

  function setStatus(key: string, status: 'running' | 'completed' | 'error'): void {
    const entry = entriesMap.get(key);
    if (entry) {
      entry.status = status;
      if (status === 'completed' || status === 'error') {
        entry.expiresAt = Date.now() + TOOL_COMPLETED_TTL_MS;
        scheduleExpiry(key, entry.expiresAt);
      }
    }
  }

  function bringToFront(key: string): void {
    const entry = entriesMap.get(key);
    if (entry) {
      entry.zIndex = nextZIndex(isManualTier(entry.key, entry.closable));
    }
  }

  function extend(key: string, ms: number): void {
    const entry = entriesMap.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + ms;
      scheduleExpiry(key, entry.expiresAt);
    }
  }

  async function close(key: string): Promise<void> {
    const entry = entriesMap.get(key);
    if (!entry) return;

    const timerId = timerMap.get(key);
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerMap.delete(key);
    }

    if (entry.beforeClose) {
      const el = document.querySelector(`[data-floating-key="${key}"]`);
      await entry.beforeClose(el as HTMLElement);
    }

    entriesMap.delete(key);

    if (entry.afterClose) {
      entry.afterClose();
    }
  }

  function closeAll(options?: { exclude?: (key: string) => boolean }): void {
    const exclude = options?.exclude;
    for (const [key, timerId] of timerMap.entries()) {
      if (exclude?.(key)) continue;
      clearTimeout(timerId);
      timerMap.delete(key);
    }
    // eslint-disable-next-line unicorn/no-useless-spread -- spread needed: close() deletes from entriesMap during iteration
    for (const key of [...entriesMap.keys()]) {
      if (exclude?.(key)) continue;
      close(key);
    }
  }

  function has(key: string): boolean {
    return entriesMap.has(key);
  }

  function get(key: string): FloatingWindowEntry | undefined {
    return entriesMap.get(key);
  }

  return {
    entries,
    open,
    updateOptions,
    setContent,
    appendContent,
    setTitle,
    setStatus,
    bringToFront,
    extend,
    close,
    closeAll,
    has,
    get,
    setExtent,
    getExtent,
  };
}
