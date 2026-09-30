import { describe, expect, it } from 'vitest';

import type { MessageInfo, MessagePart } from '../types/sse';
import {
  createDshPopupBridge,
  DSH_POPUP_SIGNATURE_MEMORY,
  DSH_POPUP_STACK_LIMIT,
  type DshPopupCollaborators,
  type DshToolWindowStatus,
} from './dshPopupBridge';

// ---------------------------------------------------------------------------
// Fixtures — the same shared MessagePart/MessageInfo contracts the Todo 19
// bridge normalizes (dsh parts, never restructured).
// ---------------------------------------------------------------------------

const SESSION_ID = 'session_dsh_primary';
const CHILD_SESSION_ID = 'session_dsh_child';
const SELECTED_CLOSURE = new Set([SESSION_ID, CHILD_SESSION_ID]);

function assistantInfo(sessionID: string): MessageInfo {
  return {
    id: `${sessionID}:msg-1`,
    sessionID,
    role: 'assistant',
    time: { created: 1 },
    parentID: '',
    modelID: 'deepseek-chat',
    providerID: 'deepseek',
    mode: '',
    agent: 'subagent',
    path: { cwd: '', root: '' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function toolPart(overrides: Partial<Extract<MessagePart, { type: 'tool' }>> = {}): MessagePart {
  return {
    type: 'tool',
    id: 'part_tool_1',
    sessionID: SESSION_ID,
    messageID: 'msg-1',
    callID: 'call_tool_1',
    tool: 'bash',
    state: { status: 'running', input: { command: 'ls' }, time: { start: 1 } },
    metadata: { source: 'dsh-web' },
    ...overrides,
  } as MessagePart;
}

function reasoningPart(sessionID = SESSION_ID): MessagePart {
  return {
    type: 'reasoning',
    id: 'part_reasoning_1',
    sessionID,
    messageID: 'msg-1',
    text: 'thinking…',
    time: { start: 1 },
    metadata: { source: 'dsh-web' },
  } as MessagePart;
}

function subagentTextPart(sessionID = CHILD_SESSION_ID): MessagePart {
  return {
    type: 'text',
    id: 'part_text_1',
    sessionID,
    messageID: 'msg-1',
    text: 'subagent working',
    time: { start: 1 },
    metadata: { source: 'dsh-web', subagent: { parentSessionId: SESSION_ID, childSessionId: sessionID, mode: 'general' } },
  } as MessagePart;
}

type Recorded = {
  openedTools: MessagePart[];
  toolStatus: Array<{ windowKey: string; status: DshToolWindowStatus | undefined }>;
  reasoning: Array<{ part: MessagePart; info?: MessageInfo }>;
  subagent: Array<{ part: MessagePart; info?: MessageInfo }>;
  closed: string[];
  scheduledReasoningClose: string[];
};

/**
 * The typed collaborator interface double: `satisfies DshPopupCollaborators` is
 * the compile-time contract (the interface exists and the bridge consumes
 * exactly these seams); the recorders are the runtime evidence that every
 * callback feeds the EXISTING popup component inputs.
 */
function collaboratorDouble(options: { suppressed?: boolean; openWindows?: string[] } = {}) {
  const recorded: Recorded = {
    openedTools: [],
    toolStatus: [],
    reasoning: [],
    subagent: [],
    closed: [],
    scheduledReasoningClose: [],
  };
  const openWindows = new Set(options.openWindows ?? []);
  const shouldRender = (tool: string) => tool === 'bash' || tool === 'read';
  const collaborators = {
    isPopupSession: (sessionID: string) => SELECTED_CLOSURE.has(sessionID),
    isSuppressed: () => options.suppressed === true,
    shouldOpenToolWindow: shouldRender,
    openToolPartWindow: (part: MessagePart) => {
      recorded.openedTools.push(part);
      openWindows.add(part.type === 'tool' ? part.callID || part.id : part.id);
    },
    updateToolWindowStatus: (windowKey: string, status: DshToolWindowStatus | undefined) => {
      recorded.toolStatus.push({ windowKey, status });
    },
    handleReasoningPart: (part: MessagePart, info?: MessageInfo) => {
      recorded.reasoning.push({ part, info });
      openWindows.add(`reasoning:${part.sessionID}`);
    },
    handleSubagentPart: (part: MessagePart, info?: MessageInfo) => {
      recorded.subagent.push({ part, info });
      openWindows.add(`subagent:${part.sessionID}`);
    },
    hasWindow: (windowKey: string) => openWindows.has(windowKey),
    closeWindow: (windowKey: string) => {
      recorded.closed.push(windowKey);
      openWindows.delete(windowKey);
    },
    scheduleReasoningClose: (sessionId: string) => {
      recorded.scheduledReasoningClose.push(sessionId);
    },
  } satisfies DshPopupCollaborators;
  return { collaborators, recorded, openWindows };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dshPopupBridge — three-way auto-popup wiring (Todo 24)', () => {
  it('exposes the type-safe collaborator interface for all three paths', () => {
    const { collaborators } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);
    expect(typeof bridge.onToolPart).toBe('function');
    expect(typeof bridge.onLiveReasoning).toBe('function');
    expect(typeof bridge.onLiveSubagent).toBe('function');
    expect(typeof bridge.onReconcilePart).toBe('function');
  });

  it('exports the normalized-output numeric constants', () => {
    expect(DSH_POPUP_STACK_LIMIT).toBe(64);
    expect(DSH_POPUP_SIGNATURE_MEMORY).toBe(256);
  });

  it('forwards a live tool part to the existing tool window inputs, distortion preserved', () => {
    const { collaborators, recorded } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);
    const part = toolPart();

    bridge.onToolPart(part);

    // Same object reference — no reshaping, re-keying or cloning.
    expect(recorded.openedTools).toHaveLength(1);
    expect(recorded.openedTools[0]).toBe(part);
    expect(recorded.toolStatus).toEqual([{ windowKey: 'call_tool_1', status: 'running' }]);
    expect(bridge.stack().map((entry) => entry.key)).toEqual(['call_tool_1']);
    expect(bridge.stack()[0].part).toBe(part);
  });

  it('forwards live reasoning to the existing reasoning window input', () => {
    const { collaborators, recorded } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);
    const part = reasoningPart();
    const info = assistantInfo(SESSION_ID);

    bridge.onLiveReasoning(info, part);

    expect(recorded.reasoning).toHaveLength(1);
    expect(recorded.reasoning[0]).toEqual({ part, info });
    expect(recorded.reasoning[0].part).toBe(part);
    expect(bridge.stack().map((entry) => entry.key)).toEqual([`reasoning:${SESSION_ID}`]);
  });

  it('forwards live subagent text to the existing subagent window input', () => {
    const { collaborators, recorded } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);
    const part = subagentTextPart();
    const info = assistantInfo(CHILD_SESSION_ID);

    bridge.onLiveSubagent(info, part);

    expect(recorded.subagent).toHaveLength(1);
    expect(recorded.subagent[0]).toEqual({ part, info });
    expect(recorded.subagent[0].part).toBe(part);
    expect(bridge.stack().map((entry) => entry.key)).toEqual([`subagent:${CHILD_SESSION_ID}`]);
  });

  it('routes subagent reasoning and subagent tool parts to their kimi-isomorphic surfaces', () => {
    const { collaborators, recorded } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);

    // Child reasoning arrives through onLiveSubagent (Todo 19 routing): the
    // tagged reasoning window, exactly like the kimi-web App.vue split.
    const childReasoning = reasoningPart(CHILD_SESSION_ID);
    bridge.onLiveSubagent(assistantInfo(CHILD_SESSION_ID), childReasoning);
    expect(recorded.reasoning.map((entry) => entry.part)).toEqual([childReasoning]);

    // Child tool parts reach the tool window surface (kimi onToolPart /
    // Codex syncRealtimeToolWindows parity) instead of being dropped.
    const childTool = toolPart({ sessionID: CHILD_SESSION_ID, id: 'part_tool_2', callID: 'call_tool_2' });
    bridge.onLiveSubagent(assistantInfo(CHILD_SESSION_ID), childTool);
    expect(recorded.openedTools[recorded.openedTools.length - 1]).toBe(childTool);
  });

  it('suppresses every path when suppressAutoWindows is on', () => {
    const { collaborators, recorded } = collaboratorDouble({ suppressed: true });
    const bridge = createDshPopupBridge(collaborators);

    bridge.onToolPart(toolPart());
    bridge.onLiveReasoning(assistantInfo(SESSION_ID), reasoningPart());
    bridge.onLiveSubagent(assistantInfo(CHILD_SESSION_ID), subagentTextPart());

    expect(recorded.openedTools).toEqual([]);
    expect(recorded.toolStatus).toEqual([]);
    expect(recorded.reasoning).toEqual([]);
    expect(recorded.subagent).toEqual([]);
    expect(bridge.stack()).toEqual([]);
  });

  it('drops parts outside the selected session descendant closure', () => {
    const { collaborators, recorded } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);

    bridge.onToolPart(toolPart({ sessionID: 'session_dsh_other' }));
    bridge.onLiveReasoning(assistantInfo('session_dsh_other'), reasoningPart('session_dsh_other'));

    expect(recorded.openedTools).toEqual([]);
    expect(recorded.reasoning).toEqual([]);
    expect(bridge.stack()).toEqual([]);
  });

  it('does not re-stack or re-forward an unchanged tool signature', () => {
    const { collaborators, recorded } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);
    const part = toolPart();

    bridge.onToolPart(part);
    bridge.onToolPart(part);

    expect(recorded.openedTools).toHaveLength(1);
    expect(bridge.stack()).toHaveLength(1);
  });

  it('survives a disconnect→reconnect redelivery without duplicate stack entries', () => {
    const { collaborators, recorded, openWindows } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);
    const running = toolPart();
    bridge.onToolPart(running);
    expect(bridge.stack()).toHaveLength(1);

    // Reconnect: the same frame is re-delivered live (identical signature) —
    // the window must not re-stack and the collaborator must not re-fire.
    bridge.onToolPart(running);
    expect(bridge.stack()).toHaveLength(1);
    expect(recorded.openedTools).toHaveLength(1);

    // The replay path re-delivers the terminal part during the snapshot
    // rebuild: update-only, never a second entry.
    const completed = toolPart({
      state: { status: 'completed', input: { command: 'ls' }, output: 'ok', title: 'ls', metadata: {}, time: { start: 1, end: 2 } },
    });
    bridge.onReconcilePart(assistantInfo(SESSION_ID), completed);
    expect(bridge.stack()).toHaveLength(1);
    expect(bridge.stack()[0].part).toBe(completed);
    expect(recorded.toolStatus[recorded.toolStatus.length - 1]).toEqual({ windowKey: 'call_tool_1', status: 'completed' });
    expect(openWindows.has('call_tool_1')).toBe(true);
  });

  it('updates a live tool part in place instead of stacking a duplicate entry', () => {
    const { collaborators, recorded } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);

    bridge.onToolPart(toolPart());
    const completed = toolPart({
      state: { status: 'completed', input: { command: 'ls' }, output: 'ok', title: 'ls', metadata: {}, time: { start: 1, end: 2 } },
    });
    bridge.onToolPart(completed);

    expect(bridge.stack()).toHaveLength(1);
    expect(bridge.stack()[0].part).toBe(completed);
    expect(recorded.openedTools).toHaveLength(2);
    expect(recorded.toolStatus[recorded.toolStatus.length - 1]).toEqual({ windowKey: 'call_tool_1', status: 'completed' });
  });

  it('keeps the latest value but never stacks or forwards while not visible', () => {
    const { collaborators, recorded } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);
    const tool = toolPart();
    const reasoning = reasoningPart();
    const subagent = subagentTextPart();

    bridge.setVisible(false);
    bridge.onToolPart(tool);
    bridge.onLiveReasoning(assistantInfo(SESSION_ID), reasoning);
    bridge.onLiveSubagent(assistantInfo(CHILD_SESSION_ID), subagent);

    expect(bridge.stack()).toEqual([]);
    expect(recorded.openedTools).toEqual([]);
    expect(recorded.toolStatus).toEqual([]);
    expect(recorded.reasoning).toEqual([]);
    expect(recorded.subagent).toEqual([]);
    // The latest normalized value is still tracked (by reference).
    expect(bridge.latestValue('call_tool_1')).toBe(tool);
    expect(bridge.latestValue(`reasoning:${SESSION_ID}`)).toBe(reasoning);
    expect(bridge.latestValue(`subagent:${CHILD_SESSION_ID}`)).toBe(subagent);

    // Becoming visible again does not retroactively stack stale state; the
    // next live frame flows normally.
    bridge.setVisible(true);
    const nextTool = toolPart({ id: 'part_tool_2', callID: 'call_tool_2' });
    bridge.onToolPart(nextTool);
    expect(bridge.stack().map((entry) => entry.key)).toEqual(['call_tool_2']);
    expect(recorded.openedTools[recorded.openedTools.length - 1]).toBe(nextTool);
  });

  it('replay never opens a window; it only reconciles already-open ones', () => {
    const { collaborators, recorded } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);

    // No window open: the replay part must not open one.
    bridge.onReconcilePart(assistantInfo(SESSION_ID), reasoningPart());
    expect(recorded.reasoning).toEqual([]);
    expect(bridge.stack()).toEqual([]);

    // Window already open from live frames: the terminal replay part updates
    // it through the same existing component input.
    const live = reasoningPart();
    bridge.onLiveReasoning(assistantInfo(SESSION_ID), live);
    const terminal = reasoningPart();
    (terminal as { time: { start: number; end?: number } }).time = { start: 1, end: 2 };
    bridge.onReconcilePart(assistantInfo(SESSION_ID), terminal);
    expect(recorded.reasoning).toHaveLength(2);
    expect(recorded.reasoning[1].part).toBe(terminal);
    expect(bridge.stack()).toHaveLength(1);
  });

  it('reconciling a terminal subagent part also closes the sibling reasoning window', () => {
    const { collaborators, recorded } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);

    // Child reasoning window + child subagent window, both from live frames.
    bridge.onLiveSubagent(assistantInfo(CHILD_SESSION_ID), reasoningPart(CHILD_SESSION_ID));
    bridge.onLiveSubagent(assistantInfo(CHILD_SESSION_ID), subagentTextPart());
    expect(bridge.stack()).toHaveLength(2);

    // A terminal child text part arrives on the replay path (volatile deltas
    // are never replayed, so the sibling reasoning window would stay open
    // forever without this — kimi-web reconcile parity).
    const terminalText = subagentTextPart();
    (terminalText as { time?: { start: number; end?: number } }).time = { start: 1, end: 2 };
    bridge.onReconcilePart(assistantInfo(CHILD_SESSION_ID), terminalText);

    expect(recorded.scheduledReasoningClose).toEqual([CHILD_SESSION_ID]);
    expect(bridge.stack()).toHaveLength(2);
  });

  it('bounds the normalized stack at the exported constant', () => {
    const { collaborators } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);
    for (let index = 0; index < DSH_POPUP_STACK_LIMIT + 8; index += 1) {
      bridge.onToolPart(toolPart({ id: `part_tool_${index}`, callID: `call_tool_${index}` }));
    }
    expect(bridge.stack().length).toBeLessThanOrEqual(DSH_POPUP_STACK_LIMIT);
    // Newest entries survive; the oldest are trimmed.
    expect(bridge.latestValue(`call_tool_${DSH_POPUP_STACK_LIMIT + 7}`)).toBeDefined();
  });

  it('reset clears stack, latest values and signatures', () => {
    const { collaborators, recorded } = collaboratorDouble();
    const bridge = createDshPopupBridge(collaborators);
    const part = toolPart();
    bridge.onToolPart(part);

    bridge.reset();
    expect(bridge.stack()).toEqual([]);
    expect(bridge.latestValue('call_tool_1')).toBeUndefined();

    // After a reset the same frame flows again (no stale signature block) —
    // the backend/session switch teardown semantics.
    bridge.onToolPart(part);
    expect(recorded.openedTools).toHaveLength(2);
    expect(bridge.stack()).toHaveLength(1);
  });
});
