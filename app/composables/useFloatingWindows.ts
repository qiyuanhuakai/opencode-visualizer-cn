import { reactive, shallowRef, markRaw, onUnmounted, nextTick, watch, type Component } from 'vue';
import { startRenderWorkerHtml, RenderCancelledError, type RenderRequest } from '../utils/workerRenderer';
import { resolveSyntaxTheme } from '../utils/themeTokens';
import { useSettings } from './useSettings';
import { useI18n } from '../i18n/useI18n';

export interface FloatingWindowEntry {
  key: string;
  autoOpen?: boolean;
  themeType?: 'shell';
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
  minimized?: boolean;
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
  minimized: false,
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
  return key.startsWith('permission:') || key.startsWith('question:') || key.startsWith('elicitation:');
}

function nextZIndex(manualTier: boolean): number {
  return ++zIndexCounter + (manualTier ? MANUAL_ZINDEX_OFFSET : 0);
}

export function getFloatingWindowDragBounds(windowSize: Extent, extent: Extent) {
  const visibleX = Math.max(
    1,
    Math.min(TITLEBAR_VISIBLE_PX, windowSize.width, extent.width),
  );
  const visibleY = Math.max(1, Math.min(TITLEBAR_VISIBLE_PX, extent.height));
  return {
    minX: visibleX - windowSize.width,
    maxX: extent.width - visibleX,
    minY: 0,
    maxY: extent.height - visibleY,
  };
}

export function getFloatingWindowSnapPosition(
  position: { x: number; y: number },
  windowSize: Extent,
  extent: Extent,
): { x: number; y: number } {
  if (extent.width <= 0 || extent.height <= 0) return position;
  const bounds = getFloatingWindowDragBounds(windowSize, extent);
  return {
    x: Math.max(bounds.minX, Math.min(position.x, bounds.maxX)),
    y: Math.max(bounds.minY, Math.min(position.y, bounds.maxY)),
  };
}

function clampEntryForCreation(entry: FloatingWindowEntry, extent: Extent): boolean {
  if (extent.width <= 0 || extent.height <= 0) return false;
  entry.width = Math.min(entry.width || 600, extent.width);
  entry.height = Math.min(entry.height || 400, extent.height);
  entry.x = Math.max(0, Math.min(entry.x, Math.max(0, extent.width - entry.width)));
  entry.y = Math.max(0, Math.min(entry.y, Math.max(0, extent.height - entry.height)));
  return true;
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
  if (status === 'completed' || status === 'error') {
    if (existing?.status === 'completed' || existing?.status === 'error') return existing.expiresAt;
    return Date.now() + TOOL_COMPLETED_TTL_MS;
  }
  // For non-terminal status, keep existing expiry if set
  if (existing && typeof existing.expiresAt === 'number') return existing.expiresAt;
  return Date.now() + TOOL_RUNNING_TTL_MS;
}

export function useFloatingWindows() {
  const { t } = useI18n();
  const { themeStorage } = useSettings();
  const entriesMap = reactive(new Map<string, FloatingWindowEntry>());
  const pendingInitialLayoutKeys = new Set<string>();
  const admissions = new Map<string, boolean>();
  let automaticOpenAllowed = true;
  const activeOpenTokens = new Map<string, symbol>();
  const entries = shallowRef<FloatingWindowEntry[]>([]);

  function rebuildEntries(): void {
    const result: FloatingWindowEntry[] = [];
    for (const entry of entriesMap.values()) {
      if (entry.isReady) result.push(entry);
    }
    entries.value = result;
  }
  let extent: Extent = {
    width: typeof window !== 'undefined' ? window.innerWidth : 1920,
    height: typeof window !== 'undefined' ? window.innerHeight : 1080,
  };

  function setExtent(w: number, h: number) {
    extent = { width: Math.max(0, w), height: Math.max(0, h) };
    if (extent.width <= 0 || extent.height <= 0 || pendingInitialLayoutKeys.size === 0) return;
    let changed = false;
    for (const key of pendingInitialLayoutKeys) {
      const entry = entriesMap.get(key);
      if (entry) changed = clampEntryForCreation(entry, extent) || changed;
      pendingInitialLayoutKeys.delete(key);
    }
    if (changed) rebuildEntries();
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

  const renderVersionMap = new Map<string, number>();

  const renderTasks = new Map<string, ReturnType<typeof startRenderWorkerHtml>>();

  async function renderContent(key: string, request: RenderRequest): Promise<string> {
    const task = startRenderWorkerHtml(request);
    renderTasks.set(key, task);
    try {
      return await task.promise;
    } catch (error) {
      if (error instanceof RenderCancelledError) return '';
      throw error;
    } finally {
      if (renderTasks.get(key) === task) renderTasks.delete(key);
    }
  }

  function bumpRenderVersion(key: string): number {
    renderTasks.get(key)?.cancel();
    renderTasks.delete(key);
    const next = (renderVersionMap.get(key) || 0) + 1;
    renderVersionMap.set(key, next);
    return next;
  }

  function scheduleExpiry(key: string, expiresAt: number): void {
    // Clear existing timer if present
    const existingTimer = timerMap.get(key);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      timerMap.delete(key);
    }
    if (expiresAt >= Number.MAX_SAFE_INTEGER) return;

    const delay = Math.max(0, expiresAt - Date.now());
    const timerId = setTimeout(() => {
      timerMap.delete(key);
      close(key);
    }, delay);
    timerMap.set(key, timerId);
  }

  function isCritical(key: string): boolean {
    return key.startsWith('permission:') || key.startsWith('question:') || key.startsWith('elicitation:');
  }

  function entryIsCurrent(entry: FloatingWindowEntry, version: number): boolean {
    if (entry.autoOpen && !isCritical(entry.key) && !automaticAllowed()) {
      if (entriesMap.get(entry.key) === entry) discard(entry.key);
      return false;
    }
    return entriesMap.get(entry.key) === entry && renderVersionMap.get(entry.key) === version;
  }

  function automaticAllowed(): boolean {
    return automaticOpenAllowed && (typeof document === 'undefined' || !document.hidden);
  }

  // Capacity and visibility disposal cannot await animation hooks before freeing a slot.
  function discard(key: string): void {
    activeOpenTokens.delete(key);
    admissions.delete(key);
    pendingInitialLayoutKeys.delete(key);
    renderVersionMap.delete(key);
    renderTasks.get(key)?.cancel();
    renderTasks.delete(key);
    const timer = timerMap.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timerMap.delete(key);
    const entry = entriesMap.get(key);
    entriesMap.delete(key);
    rebuildEntries();
    entry?.afterClose?.();
  }

  function setAutomaticOpenAllowed(allowed: boolean): void {
    automaticOpenAllowed = allowed;
    if (automaticAllowed()) return;
    for (const [key, automatic] of admissions) {
      if (automatic && !isCritical(key)) discard(key);
    }
  }

  function onVisibilityChange(): void {
    if (document.hidden) setAutomaticOpenAllowed(automaticOpenAllowed);
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

  onUnmounted(() => {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
    admissions.clear();
    entriesMap.clear();
    rebuildEntries();
    for (const task of renderTasks.values()) task.cancel();
    renderTasks.clear();
    activeOpenTokens.clear();
    pendingInitialLayoutKeys.clear();
    for (const timerId of timerMap.values()) {
      clearTimeout(timerId);
    }
    timerMap.clear();
    renderVersionMap.clear();
  });

  function focusWindowBody(key: string): void {
    nextTick(() => {
      const body = document.querySelector(
        `[data-floating-key="${key}"] .floating-window-body`,
      ) as HTMLElement | null;
      if (!body) return;
      body.focus();
    });
  }

  async function open(key: string, opts: Partial<FloatingWindowEntry>): Promise<void> {
    const automatic = opts.autoOpen ?? entriesMap.get(key)?.autoOpen ?? false;
    if (automatic && !isCritical(key) && !automaticAllowed()) return;
    if (!admissions.has(key)) {
      while (admissions.size >= 30) {
        const oldest = [...admissions.keys()].find(candidate => !isCritical(candidate));
        if (oldest === undefined) {
          if (!isCritical(key)) return;
          break;
        }
        discard(oldest);
      }
    }
    admissions.set(key, automatic);
    const openToken = Symbol(key);
    activeOpenTokens.set(key, openToken);
    const existing = entriesMap.get(key);

    // Merge with defaults and existing
    const merged: FloatingWindowEntry = {
      ...DEFAULT_OPTS,
      ...existing,
      ...opts,
      key,
      time: existing?.time ?? Date.now(),
      zIndex: existing
        ? existing.zIndex
        : nextZIndex(isManualTier(key, resolveEntryClosable(opts, existing))),
    } as FloatingWindowEntry;

    // When updating an existing entry, merge props instead of replacing
    if (existing && existing.props && opts.props) {
      merged.props = { ...existing.props, ...opts.props };
    }

    if (!existing && (opts.x == null || opts.y == null)) {
      const pos = getRandomPosition(merged.width ?? 600, merged.height ?? 400);
      merged.x = opts.x ?? pos.x;
      merged.y = opts.y ?? pos.y;
    }

    // Execute beforeOpen hook
    if (merged.beforeOpen) {
      try {
        await merged.beforeOpen();
      } catch (error) {
        if (activeOpenTokens.get(key) === openToken) {
          activeOpenTokens.delete(key);
          if (!existing) admissions.delete(key);
        }
        throw error;
      }
    }

    if (activeOpenTokens.get(key) !== openToken) return;
    if (automatic && !isCritical(key) && !automaticAllowed()) {
      discard(key);
      return;
    }
    const liveEntry = entriesMap.get(key);
    if (liveEntry) {
      merged.x = liveEntry.x;
      merged.y = liveEntry.y;
      merged.width = liveEntry.width;
      merged.height = liveEntry.height;
      merged.minimized = liveEntry.minimized;
      merged.zIndex = liveEntry.zIndex;
    }
    if (!liveEntry && !clampEntryForCreation(merged, extent)) pendingInitialLayoutKeys.add(key);

    merged.isReady = true;
    const contentVersion = bumpRenderVersion(key);

    const resolveContent = async () => {
      const entry = entriesMap.get(key);
      if (!entry) return;
      const isCurrent = () => entryIsCurrent(entry, contentVersion);
      if (!isCurrent()) return;

      if (typeof merged.content === 'function') {
        try {
          const resolved = await (merged.content as () => Promise<string>)();
          if (!isCurrent()) return;
          entry.resolvedHtml = resolved;
        } catch (e) {
          if (!isCurrent()) return;
          entry.resolvedHtml = String(e);
        }
      } else if (merged.content && merged.lang) {
        try {
          const resolved = await renderContent(key, {
            id: nextRenderId(),
            code: merged.content,
            lang: merged.lang,
            theme: resolveSyntaxTheme(themeStorage.value),
            gutterMode: variantToGutterMode(merged.variant),
            lineOffset: merged.lineOffset,
            lineLimit: merged.lineLimit,
            copyButtonLabel: t('render.copyCode'),
            copiedLabel: t('render.copied'),
            copyCodeAriaLabel: t('render.copyCodeAria'),
            copyMarkdownAriaLabel: t('render.copyMarkdownAria'),
          });
          if (!isCurrent()) return;
          entry.resolvedHtml = resolved;
        } catch {
          if (!isCurrent()) return;
          entry.resolvedHtml = `<pre>${merged.content}</pre>`;
        }
      } else if (merged.content) {
        entry.resolvedHtml = merged.content;
      } else {
        entry.resolvedHtml = '';
      }
    };

    merged.expiresAt = resolveExpiresAt(opts, existing);

    const shouldFocusOnOpen = !existing && merged.focusOnOpen === true;

    entriesMap.set(key, sanitizeEntry(merged));
    if (activeOpenTokens.get(key) === openToken) activeOpenTokens.delete(key);
    rebuildEntries();
    void resolveContent();

    scheduleExpiry(key, merged.expiresAt);

    if (merged.afterOpen) {
      nextTick(() => {
        if (renderVersionMap.get(key) !== contentVersion || !entriesMap.has(key)) return;
        const el = document.querySelector(`[data-floating-key="${key}"]`);
        if (el) merged.afterOpen!(el as HTMLElement);
      });
    }

    if (shouldFocusOnOpen) {
      focusWindowBody(key);
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

     // When updating an existing entry, merge props instead of replacing
     if (existing.props && partialOpts.props) {
       merged.props = { ...existing.props, ...partialOpts.props };
     }

     // Status-based expiry
     if (partialOpts.status && !partialOpts.expiresAt) {
       if (partialOpts.status === 'completed' || partialOpts.status === 'error') {
         merged.expiresAt = resolveExpiresAt(partialOpts, existing);
       }
     }

     Object.assign(existing, sanitizeEntry(merged));
     rebuildEntries();

     if (partialOpts.status === 'completed' || partialOpts.status === 'error') {
        scheduleExpiry(key, merged.expiresAt);
      }
    }

  async function setContent(key: string, text: string, lang?: string): Promise<void> {
    const entry = entriesMap.get(key);
    if (!entry) return;

    const contentVersion = bumpRenderVersion(key);
    if (!entryIsCurrent(entry, contentVersion)) return;
    entry.content = text;
    entry.lang = lang;

    if (lang) {
      const resolved = await renderContent(key, {
        id: nextRenderId(),
        code: text,
        lang,
        theme: resolveSyntaxTheme(themeStorage.value),
        gutterMode: variantToGutterMode(entry.variant),
        lineOffset: entry.lineOffset,
        lineLimit: entry.lineLimit,
        copyButtonLabel: t('render.copyCode'),
        copiedLabel: t('render.copied'),
        copyCodeAriaLabel: t('render.copyCodeAria'),
        copyMarkdownAriaLabel: t('render.copyMarkdownAria'),
      });
      if (!entryIsCurrent(entry, contentVersion)) return;
      entry.resolvedHtml = resolved;
    } else {
      entry.resolvedHtml = text;
    }
  }

  watch(
    () => resolveSyntaxTheme(themeStorage.value),
    () => {
      for (const entry of entriesMap.values()) {
        if (!entry.isReady) continue;
        if (typeof entry.content === 'string' && entry.lang) {
          void setContent(entry.key, entry.content, entry.lang);
        } else if (typeof entry.content === 'function') {
          const contentVersion = bumpRenderVersion(entry.key);
          if (!entryIsCurrent(entry, contentVersion)) continue;
          const content = entry.content;
          void content().then((html) => {
            if (entryIsCurrent(entry, contentVersion)) {
              entry.resolvedHtml = html;
            }
          }).catch((error) => {
            if (entryIsCurrent(entry, contentVersion)) {
              entry.resolvedHtml = String(error);
            }
          });
        }
      }
    },
  );

  async function appendContent(key: string, text: string, lang?: string): Promise<void> {
    const entry = entriesMap.get(key);
    if (!entry) return;

    const contentVersion = bumpRenderVersion(key);
    if (!entryIsCurrent(entry, contentVersion)) return;
    const newContent = (entry.content || '') + text;
    entry.content = newContent;

    if (lang || entry.lang) {
      const resolved = await renderContent(key, {
        id: nextRenderId(),
        code: newContent,
        lang: lang || entry.lang!,
        theme: resolveSyntaxTheme(themeStorage.value),
        gutterMode: variantToGutterMode(entry.variant),
        copyButtonLabel: t('render.copyCode'),
        copiedLabel: t('render.copied'),
        copyCodeAriaLabel: t('render.copyCodeAria'),
        copyMarkdownAriaLabel: t('render.copyMarkdownAria'),
      });
      if (!entryIsCurrent(entry, contentVersion)) return;
      entry.resolvedHtml = resolved;
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
      const expiresAt = resolveExpiresAt({ status }, entry);
      entry.status = status;
      if (status === 'completed' || status === 'error') {
        entry.expiresAt = expiresAt;
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

  function minimize(key: string): void {
    const entry = entriesMap.get(key);
    if (!entry) return;
    entry.minimized = true;
  }

  function restore(key: string): void {
    const entry = entriesMap.get(key);
    if (!entry) return;
    entry.minimized = false;
    bringToFront(key);
  }

  // Explicit user activation only: unlike open(), never re-resolves content,
  // resets geometry, or runs on automatic updates.
  function activate(key: string): void {
    const entry = entriesMap.get(key);
    if (!entry) return;
    entry.minimized = false;
    bringToFront(key);
    focusWindowBody(key);
  }

  function extend(key: string, ms: number): void {
    const entry = entriesMap.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + ms;
      scheduleExpiry(key, entry.expiresAt);
    }
  }

  async function close(key: string, skipRebuild = false): Promise<void> {
    activeOpenTokens.delete(key);
    if (!entriesMap.has(key)) admissions.delete(key);
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

    if (entriesMap.get(key) !== entry) return;
    admissions.delete(key);
    renderTasks.get(key)?.cancel();
    renderTasks.delete(key);
    pendingInitialLayoutKeys.delete(key);
    entriesMap.delete(key);
    renderVersionMap.delete(key);
    if (!skipRebuild) rebuildEntries();

    if (entry.afterClose) {
      entry.afterClose();
    }
  }

  async function closeAll(options?: { exclude?: (key: string) => boolean }): Promise<void> {
    const exclude = options?.exclude;
    for (const key of activeOpenTokens.keys()) {
      if (!exclude?.(key)) {
        activeOpenTokens.delete(key);
        if (!entriesMap.has(key)) admissions.delete(key);
      }
    }
    for (const [key, timerId] of timerMap.entries()) {
      if (exclude?.(key)) continue;
      clearTimeout(timerId);
      timerMap.delete(key);
    }
    const keys = [...entriesMap.keys()].filter((key) => !exclude?.(key));
    await Promise.all(keys.map((key) => close(key, true)));
    rebuildEntries();
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
    minimize,
    restore,
    activate,
    extend,
    close,
    closeAll,
    has,
    get,
    setAutomaticOpenAllowed,
    setExtent,
    getExtent,
  };
}
