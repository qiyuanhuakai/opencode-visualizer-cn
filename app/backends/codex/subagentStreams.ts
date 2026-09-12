import type { AssistantMessageInfo, MessagePart } from '../../types/sse';
import type { CodexJsonRpcNotification } from './jsonRpcProtocol';
import { normalizeCodexTurnItems, type CodexNormalizeModel } from './normalize';

type Wire = Readonly<Record<string, unknown>>;
type LiveItem = { wire: Wire; turnId: string; created: number; done: boolean; signature?: string };
type Child = { modelID: string; providerID: string; agent: string; agentPath: string; live: boolean; items: Map<string, LiveItem> };
const MAX_CHILDREN = 128;
const MAX_ITEMS = 256;
const MAX_TEXT = 200_000;
function record(value: unknown): Wire {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
function text(value: unknown) { return typeof value === 'string' ? value : ''; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function agentName(value: unknown) { return text(value).split('/').filter(Boolean).at(-1) || ''; }

export function createCodexSubagentStreams(options: {
  readonly getSelectedParent: () => string | null;
  readonly publish: (info: AssistantMessageInfo, part: MessagePart) => void;
  readonly onDiscover?: (threadId: string, live: boolean) => void;
}) {
  const children = new Map<string, Child>();
  let selected = options.getSelectedParent();
  function reset() { children.clear(); selected = options.getSelectedParent(); }
  function sync() { if (selected !== options.getSelectedParent()) reset(); }
  function known(id: string) { return Boolean(selected) && (id === selected || children.has(id)); }
  function discover(id: string, metadata: Wire = {}, live = true) {
    if (!id || id === selected) return;
    let child = children.get(id);
    const fresh = !child;
    if (!child) {
      if (children.size >= MAX_CHILDREN) return;
      child = { modelID: '', providerID: '', agent: '', agentPath: '', live: false, items: new Map() };
      children.set(id, child);
    }
    child.modelID = text(metadata.modelID) || text(metadata.model) || child.modelID;
    child.providerID = text(metadata.providerID) || text(metadata.modelProvider) || child.providerID;
    child.agentPath = agentName(metadata.agentPath) || agentName(metadata.agent_path) || child.agentPath;
    child.agent = child.agentPath || agentName(metadata.agentNickname) || agentName(metadata.agentRole) || child.agent;
    const activate = live && !child.live;
    child.live ||= live;
    if (fresh || activate) options.onDiscover?.(id, live);
  }
  function discoverItem(owner: string, item: Wire, live = true) {
    if (!known(owner)) return;
    switch (item.type) {
      case 'subAgentActivity': discover(text(item.agentThreadId), { agentPath: item.agentPath }, live); return;
      case 'collabToolCall':
      case 'collabAgentToolCall': {
        if (text(item.senderThreadId) && item.senderThreadId !== owner) return;
        const ids = list(item.receiverThreadIds);
        for (const id of ids.length ? ids : [item.newThreadId, item.receiverThreadId]) discover(text(id), {}, live);
        return;
      }
      default: return;
    }
  }
  function threadMetadata(thread: Wire, live = true) {
    const id = text(thread.id);
    const source = record(thread.source);
    const subagent = record(source.subAgent);
    const spawn = record(subagent.thread_spawn ?? subagent.threadSpawn);
    const parent = text(thread.parentThreadId) || text(spawn.parent_thread_id) || text(spawn.parentThreadId);
    if (known(parent) || children.has(id)) discover(id, { ...spawn, ...thread }, live);
    return id;
  }
  function remember(child: Child, key: string, item: LiveItem) {
    if (!child.items.has(key) && child.items.size >= MAX_ITEMS) {
      const oldest = child.items.keys().next().value;
      if (oldest !== undefined) child.items.delete(oldest);
    }
    child.items.set(key, item);
  }
  function registerHistory(value: unknown, model?: CodexNormalizeModel, catchUp = false) {
    sync();
    const thread = record(value);
    const id = threadMetadata({ ...thread, ...model }, false);
    if (!known(id)) return;
    const liveChild = children.get(id);
    if (liveChild) {
      for (const item of liveChild.items.values()) if (item.signature) emit(id, liveChild, item);
    }
    const turns = list(thread.turns);
    for (const rawTurn of turns) {
      const turn = record(rawTurn);
      for (const rawItem of list(turn.items)) {
        const item = record(rawItem);
        discoverItem(id, item, false);
        const child = children.get(id);
        const itemId = text(item.id);
        const turnId = text(turn.id);
        if (child && itemId && turnId) {
          const key = `${turnId}:${itemId}`;
          const previous = child.items.get(key);
          if (!previous || (catchUp && !previous.signature)) {
            remember(child, key, { wire: item, turnId, created: previous?.created ?? Date.now(), done: turn.status !== 'inProgress' && turn.status !== 'running' });
          }
          const current = child.items.get(key);
          if (catchUp && rawTurn === turns.at(-1) && current) emit(id, child, current);
        }
      }
    }
  }
  function emit(id: string, child: Child, item: LiveItem) {
    const signature = JSON.stringify([item.wire, item.done, child.modelID, child.providerID, child.agent]);
    if (signature === item.signature) return;
    item.signature = signature;
    const bundle = normalizeCodexTurnItems({ sessionId: id, turnId: item.turnId, items: [item.wire], createdAt: item.created, turnStatus: item.done ? 'completed' : 'inProgress' });
    for (const part of bundle.parts) {
      const info = bundle.messages.find(message => message.id === part.messageID);
      if (info?.role !== 'assistant') continue;
      let stamped: MessagePart = part.type === 'text' || part.type === 'reasoning'
        ? { ...part, time: { start: item.created, ...(item.done ? { end: Date.now() } : {}) } } : part;
      if (part.type === 'tool' && part.state.status === 'completed' && !item.done) {
        stamped = { ...part, state: { status: 'running', input: part.state.input, title: part.state.title,
          metadata: { ...part.state.metadata, output: part.state.output }, time: { start: item.created } } };
      }
      if (stamped.type === 'tool') stamped = { ...stamped, id: `${id}:${stamped.id}`, callID: `${id}:${stamped.callID}` };
      options.publish({ ...info, modelID: child.modelID, providerID: child.providerID, agent: child.agent,
        time: { created: item.created, ...(item.done ? { completed: Date.now() } : {}) } }, stamped);
    }
  }
  function handle(notification: CodexJsonRpcNotification): boolean {
    sync();
    const params = record(notification.params);
    if (notification.method === 'thread/started') {
      const id = threadMetadata(record(params.thread));
      return children.has(id);
    }
    const id = text(params.threadId);
    if (!known(id)) return false;
    const wireItem = record(params.item);
    discoverItem(id, wireItem);
    const child = children.get(id);
    if (!child) return false;
    const turn = record(params.turn);
    const turnId = text(params.turnId) || text(turn.id);
    discover(id, { ...params, ...turn, ...wireItem }, false);
    if (notification.method === 'turn/started') return true;
    const status = text(record(params.status).type) || text(params.status);
    const terminalStatus = notification.method === 'thread/status/changed' && ['idle', 'systemError', 'notLoaded'].includes(status);
    if (notification.method === 'turn/completed' || notification.method === 'thread/closed' || notification.method === 'thread/archived' || terminalStatus) {
      for (const item of child.items.values()) {
        if (item.done || (turnId && item.turnId !== turnId)) continue;
        item.done = true;
        item.wire = { ...item.wire, status: text(turn.status) === 'failed' || status === 'systemError' ? 'failed' : 'completed' };
        if (item.signature) emit(id, child, item);
      }
      return true;
    }
    const itemId = text(params.itemId) || text(wireItem.id);
    if (!turnId || !itemId) return true;
    const key = `${turnId}:${itemId}`;
    const previous = child.items.get(key);
    if (previous?.done) return true;
    const item: LiveItem = previous ?? { wire: { id: itemId }, turnId, created: Date.now(), done: false };
    const delta = text(params.delta);
    switch (notification.method) {
      case 'item/started':
      case 'item/completed':
        item.done = notification.method === 'item/completed';
        item.wire = { ...item.wire, ...wireItem, status: text(wireItem.status) || (item.done ? 'completed' : 'inProgress') };
        break;
      case 'item/agentMessage/delta':
        item.wire = { ...item.wire, type: 'agentMessage', text: (text(item.wire.text) + delta).slice(-MAX_TEXT) };
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const field = notification.method === 'item/reasoning/summaryTextDelta' ? 'summary' : 'text';
        const index = typeof params.summaryIndex === 'number' ? params.summaryIndex : typeof params.contentIndex === 'number' ? params.contentIndex : 0;
        if (!Number.isInteger(index) || index < 0 || index > 255) return true;
        const blocks = list(item.wire[field]).map(text);
        blocks[index] = (text(blocks[index]) + delta).slice(-MAX_TEXT);
        item.wire = { ...item.wire, type: 'reasoning', [field]: blocks };
        break;
      }
      case 'item/commandExecution/outputDelta':
        item.wire = { ...item.wire, type: 'commandExecution', status: 'inProgress', aggregatedOutput: (text(item.wire.aggregatedOutput) + delta).slice(-MAX_TEXT) };
        break;
      default: return true;
    }
    remember(child, key, item);
    emit(id, child, item);
    return true;
  }
  return { handle, registerHistory, reset };
}
