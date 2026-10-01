/**
 * dsh auto-popup bridge (plan Todo 24).
 *
 * Mirrors the kimi-web popup wiring (kimi-web-adapt Todo 16 — App.vue
 * `syncKimiWebToolWindow` / `isKimiWebPopupSession` / `reconcileKimiWebPopup`,
 * pinned by `useKimiWebPopups.integration.test.ts`) as a typed collaborator
 * seam: the three LIVE callbacks the dsh message bridge (Todo 19
 * `useDshMessageBridge`) exposes — `onToolPart` / `onLiveReasoning` /
 * `onLiveSubagent` — are normalized here and forwarded to the EXISTING
 * floating-window surfaces through injected collaborators. This module owns
 * NO popup behavior of its own (it never opens a window, renders, or imports
 * a component): every effect goes through a collaborator, so dsh keeps the
 * Kimi Web visual contract exactly — isomorphism, not a second visual system.
 *
 * Contracts, each mirroring the kimi-web block line-for-line:
 *
 *   1. Session gate — only the selected session's descendants may drive
 *      popups (Codex `useCodexMessageBridge.ts` L197-209 parent-filter
 *      precedent). dsh subagents are real child sessions (opaque
 *      `childSessionId`, `backends/dsh/handlers-agent.ts`), so the closure is
 *      injected as `isPopupSession` instead of a string-prefix test.
 *   2. Suppression — `suppressAutoWindows` blocks every path, injected as
 *      `isSuppressed` (kimi parity: the flag is checked before anything else).
 *   3. Tool windows — the same allow-list gate (`shouldOpenToolWindow`), the
 *      same content-signature dedup and the same `fw.updateOptions` status
 *      sync as `syncKimiWebToolWindow`. An unchanged signature is not
 *      re-forwarded and never re-stacks: that is what keeps a
 *      disconnect→reconnect redelivery from duplicating a window.
 *   4. Subagent split — `onLiveSubagent` routes a reasoning-typed child part
 *      to the reasoning surface (the tagged `[subagent]` reasoning window,
 *      kimi/Codex parity), a text part to the subagent surface, and a tool
 *      part to the tool surface (kimi delivers child tool parts through
 *      `onToolPart`; the Todo 19 dsh routing sends them through
 *      `onLiveSubagent`, so the split here is what preserves the visual
 *      result). Every other part type carries no window and is dropped.
 *   5. Replay/rebuild — `onReconcilePart` may UPDATE or CLOSE an
 *      already-tracked window (`hasWindow` gate) and never opens one. A
 *      terminal child text part also closes the sibling reasoning window:
 *      subagent deltas are volatile and never replayed, so after a reconnect
 *      normalizer reset the bridge can no longer deliver the sibling's
 *      terminal part (kimi `reconcileKimiWebPopup` parity, minimized windows
 *      included). The kimi variant additionally closes a subagent window for
 *      a reasoning-typed reconcile part; the dsh bridge's `onReconcilePart`
 *      carries no kind discriminator, so that branch cannot be expressed and
 *      the reasoning path routes by part type only.
 *   6. Frames are forwarded BY REFERENCE — no payload is reshaped, re-keyed
 *      or cloned, so the window components see the exact part the bridge
 *      normalized.
 *
 * Normalized output: the bridge keeps a bounded stack of tracked popup
 * entries keyed by the SAME identity the existing window surfaces use, plus
 * the latest value per key. A redelivered frame updates its entry in place
 * (identity-keyed) instead of stacking a duplicate. `visible=false` still
 * records the latest value — a surface that comes back sees current state —
 * but nothing enters the stack and no collaborator is called.
 */

import type { MessageInfo, MessagePart } from '../types/sse';

/** Tool-window status surface (mirrors the `ToolState` status the fw consumes). */
export type DshToolWindowStatus = 'running' | 'completed' | 'error';

/**
 * Normalized-output bounds. Same visual behavior as the kimi-web path: the
 * kimi block keeps its signature map unbounded (`lastKimiWebToolWindowSignature`)
 * and lets the window surface own the windows; these constants only bound the
 * bridge's bookkeeping so a long-lived session cannot grow it without limit.
 * The values are far above any realistic session (one entry per live window),
 * so trimming never changes what the user sees.
 */
export const DSH_POPUP_STACK_LIMIT = 64;
export const DSH_POPUP_SIGNATURE_MEMORY = 256;

/** Which existing popup surface an entry belongs to. */
export type DshPopupKind = 'tool' | 'reasoning' | 'subagent';

/** One tracked popup entry. `part` is forwarded by reference (never cloned). */
export type DshPopupStackEntry = {
  readonly key: string;
  readonly kind: DshPopupKind;
  readonly part: MessagePart;
};

/**
 * The typed collaborator interface — one method per seam of the EXISTING
 * popup surfaces (App.vue binds them: `openToolPartAsWindow`, `fw.updateOptions`,
 * `reasoning.handlePart`, `subagentWindows.handlePart`, `fw.has`, `fw.close`,
 * `reasoning.scheduleReasoningClose`, the session gate and the suppression
 * flag). The bridge contains no handlers of its own; a collaborator double
 * implements this interface exactly.
 */
export interface DshPopupCollaborators {
  /** Selected session + descendants closure (the Codex parent filter). */
  isPopupSession(sessionID: string): boolean;
  /** The user's `suppressAutoWindows` setting. */
  isSuppressed(): boolean;
  /** The shared tool-window allow list (`shouldRenderToolWindow`). */
  shouldOpenToolWindow(tool: string): boolean;
  /** Tool parts → `openToolPartAsWindow` (the existing tool window input). */
  openToolPartWindow(part: MessagePart): void;
  /** Tool parts → `fw.updateOptions(windowKey, { status })`. */
  updateToolWindowStatus(windowKey: string, status: DshToolWindowStatus | undefined): void;
  /** Reasoning parts → `reasoning.handlePart`. */
  handleReasoningPart(part: MessagePart, info?: MessageInfo): void;
  /** Subagent text parts → `subagentWindows.handlePart`. */
  handleSubagentPart(part: MessagePart, info?: MessageInfo): void;
  /** Already-open window probe (`fw.has`) — the reconcile-only gate. */
  hasWindow(windowKey: string): boolean;
  /** Sibling window close (`fw.close`). */
  closeWindow(windowKey: string): void;
  /** Delayed reasoning close (`reasoning.scheduleReasoningClose`). */
  scheduleReasoningClose(sessionId: string): void;
}

export type DshPopupBridge = {
  /** Live tool part → the tool window surface (Todo 19 callback). */
  onToolPart(part: MessagePart): void;
  /** Live reasoning part → the reasoning window surface (Todo 19 callback). */
  onLiveReasoning(info: MessageInfo, part: MessagePart): void;
  /** Live child-session part → reasoning/subagent/tool surfaces (Todo 19 callback). */
  onLiveSubagent(info: MessageInfo, part: MessagePart): void;
  /** Replay/snapshot-rebuild/history part → update-or-close only, never open. */
  onReconcilePart(info: MessageInfo | undefined, part: MessagePart): void;
  /** Tracked entries, insertion ordered; a redelivery updates in place. */
  stack(): readonly DshPopupStackEntry[];
  /** Latest normalized value per window key (tracked even when not visible). */
  latestValue(windowKey: string): MessagePart | undefined;
  /** Surface visibility: false records latest values only. */
  isVisible(): boolean;
  setVisible(visible: boolean): void;
  /** Drop all bookkeeping (backend/session switch teardown). */
  reset(): void;
};

export type DshPopupBridgeOptions = {
  /** Surface visibility at construction (default true: popups flow). */
  readonly visible?: boolean;
};

// ---------------------------------------------------------------------------
// Window identity + normalization helpers (pure functions of the part)
// ---------------------------------------------------------------------------

/** The tool window key the existing surface uses: `callID` else part id. */
function toolWindowKeyOf(part: MessagePart): string {
  return part.type === 'tool' ? part.callID || part.id : part.id;
}

/** The reasoning window key (`useReasoningWindows` prefix). */
function reasoningWindowKeyOf(part: MessagePart): string {
  return `reasoning:${part.sessionID}`;
}

/** The subagent window key (`useSubagentWindows` prefix). */
function subagentWindowKeyOf(part: MessagePart): string {
  return `subagent:${part.sessionID}`;
}

/** `fw` status for a tool part — the kimi `kimiWebToolWindowStatus` mapping. */
function toolWindowStatusOf(part: MessagePart): DshToolWindowStatus | undefined {
  if (part.type !== 'tool') return undefined;
  const status = part.state.status;
  return status === 'running' || status === 'completed' || status === 'error' ? status : undefined;
}

/**
 * The kimi content signature: an unchanged signature means the window already
 * shows exactly this state, so the frame is not re-forwarded. This is the
 * dedup that keeps a disconnect→reconnect redelivery from restacking.
 */
function toolWindowSignatureOf(part: MessagePart): string {
  if (part.type !== 'tool') return '';
  const state = part.state;
  const contentSignature =
    state.status === 'completed'
      ? state.output
      : state.status === 'error'
        ? state.error
        : state.status === 'running'
          ? state.metadata?.output || ''
          : '';
  return `${part.tool}:${state.status}:${contentSignature}:${JSON.stringify(state.input ?? {})}`;
}

/** A terminal part is final: its window is closing/closed, never re-updated. */
function isTerminalPart(part: MessagePart): boolean {
  if (part.type === 'tool') return part.state.status === 'completed' || part.state.status === 'error';
  // Not every part type carries a `time` (and RetryPart's carries no `end`).
  const time = (part as { time?: { end?: number } }).time;
  return time?.end !== undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDshPopupBridge(
  collaborators: DshPopupCollaborators,
  options: DshPopupBridgeOptions = {},
): DshPopupBridge {
  let visible = options.visible ?? true;
  /** Tracked entries — insertion ordered; upsert keeps the original position. */
  const entries = new Map<string, DshPopupStackEntry>();
  /** Latest normalized value per window key (survives `visible=false`). */
  const latest = new Map<string, MessagePart>();
  /** Last forwarded tool signature per window key (the kimi dedup). */
  const signatures = new Map<string, string>();

  /** Session + suppression gates (kimi order: suppression first). */
  function admitted(sessionID: string): boolean {
    if (!sessionID) return false;
    if (collaborators.isSuppressed()) return false;
    return collaborators.isPopupSession(sessionID);
  }

  /** Bound the bookkeeping maps; terminal entries are trimmed first. */
  function trim(): void {
    while (entries.size > DSH_POPUP_STACK_LIMIT) {
      let evicted = false;
      for (const [key, entry] of entries) {
        if (isTerminalPart(entry.part)) {
          entries.delete(key);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    }
    while (latest.size > DSH_POPUP_STACK_LIMIT) {
      const oldest = latest.keys().next();
      if (oldest.done) break;
      latest.delete(oldest.value);
    }
    while (signatures.size > DSH_POPUP_SIGNATURE_MEMORY) {
      const oldest = signatures.keys().next();
      if (oldest.done) break;
      signatures.delete(oldest.value);
    }
  }

  function rememberLatest(key: string, part: MessagePart): void {
    latest.set(key, part);
    trim();
  }

  /** Track an entry under its window identity — updates in place, never dups. */
  function track(key: string, kind: DshPopupKind, part: MessagePart): void {
    entries.set(key, { key, kind, part });
    trim();
  }

  /** The tool path: allow-list, signature dedup, open + status sync. */
  function forwardToolPart(part: MessagePart): void {
    if (part.type !== 'tool') return;
    if (!admitted(part.sessionID)) return;
    if (!collaborators.shouldOpenToolWindow(part.tool)) return;
    const key = toolWindowKeyOf(part);
    rememberLatest(key, part);
    if (!visible) return;
    const signature = toolWindowSignatureOf(part);
    if (signatures.get(key) === signature) return;
    signatures.set(key, signature);
    collaborators.openToolPartWindow(part);
    collaborators.updateToolWindowStatus(key, toolWindowStatusOf(part));
    track(key, 'tool', part);
  }

  function forwardReasoningPart(info: MessageInfo | undefined, part: MessagePart): void {
    if (!admitted(part.sessionID)) return;
    const key = reasoningWindowKeyOf(part);
    rememberLatest(key, part);
    if (!visible) return;
    collaborators.handleReasoningPart(part, info);
    track(key, 'reasoning', part);
  }

  function forwardSubagentPart(info: MessageInfo | undefined, part: MessagePart): void {
    if (!admitted(part.sessionID)) return;
    const key = subagentWindowKeyOf(part);
    rememberLatest(key, part);
    if (!visible) return;
    collaborators.handleSubagentPart(part, info);
    track(key, 'subagent', part);
  }

  return {
    onToolPart(part: MessagePart): void {
      if (part.type !== 'tool') return;
      forwardToolPart(part);
    },

    onLiveReasoning(info: MessageInfo, part: MessagePart): void {
      if (part.type !== 'reasoning') return;
      forwardReasoningPart(info, part);
    },

    onLiveSubagent(info: MessageInfo, part: MessagePart): void {
      // Child parts arrive here regardless of type (Todo 19 routing); the
      // split is the kimi-web App.vue split: reasoning → tagged reasoning
      // window, tool → tool window, text → subagent window.
      if (part.type === 'reasoning') {
        forwardReasoningPart(info, part);
        return;
      }
      if (part.type === 'tool') {
        forwardToolPart(part);
        return;
      }
      if (part.type !== 'text') return;
      forwardSubagentPart(info, part);
    },

    onReconcilePart(info: MessageInfo | undefined, part: MessagePart): void {
      // Replay/snapshot rebuild/history: update-or-close only, never open.
      if (!admitted(part.sessionID)) return;
      if (part.type === 'tool') {
        const key = toolWindowKeyOf(part);
        rememberLatest(key, part);
        if (!collaborators.hasWindow(key)) return;
        collaborators.openToolPartWindow(part);
        collaborators.updateToolWindowStatus(key, toolWindowStatusOf(part));
        // Update in place only — the entry must already be tracked; a replay
        // frame never creates one.
        if (entries.has(key)) track(key, 'tool', part);
        return;
      }
      if (part.type === 'reasoning') {
        const key = reasoningWindowKeyOf(part);
        rememberLatest(key, part);
        if (!collaborators.hasWindow(key)) return;
        collaborators.handleReasoningPart(part, info);
        if (entries.has(key)) track(key, 'reasoning', part);
        return;
      }
      if (part.type !== 'text') return;
      const key = subagentWindowKeyOf(part);
      rememberLatest(key, part);
      if (collaborators.hasWindow(key)) collaborators.handleSubagentPart(part, info);
      if (entries.has(key)) track(key, 'subagent', part);
      // Volatile subagent deltas are never replayed, so a terminal child text
      // part on the replay path is the ONLY chance to close the sibling
      // reasoning window (kimi reconcile parity; minimized windows included).
      const siblingKey = reasoningWindowKeyOf(part);
      if (collaborators.hasWindow(siblingKey)) collaborators.scheduleReasoningClose(part.sessionID);
    },

    stack(): readonly DshPopupStackEntry[] {
      return [...entries.values()];
    },

    latestValue(windowKey: string): MessagePart | undefined {
      return latest.get(windowKey);
    },

    isVisible(): boolean {
      return visible;
    },

    setVisible(next: boolean): void {
      visible = next;
    },

    reset(): void {
      entries.clear();
      latest.clear();
      signatures.clear();
    },
  };
}
