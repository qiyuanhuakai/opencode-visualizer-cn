import { requireValue } from '../../shared/runtime/capabilities.js';
import type { HarnessKind } from '../../shared/runtime/harnessContract.js';
import { normalizeCodexTurnsToHistory } from '../../shared/runtime/native/codex/normalize.js';
import { applyAcpUpdate, createAcpSessionState } from '../backends/acp/history';
import { parseSessionUpdateParams } from '../backends/acp/wire';
import { createDshNormalizer } from '../backends/dsh/normalize';
import { kimiWebTranscriptToHistoryEntries } from '../backends/kimiWeb/historyEntries';
import type { KimiWebTranscriptFrame, KimiWebTranscriptTurn } from '../utils/kimiWeb';
import type { MessageInfo, MessagePart } from '../types/sse';

function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'history.record');
  return Object.fromEntries(Object.entries(value));
}
function kimiFrame(value: unknown): KimiWebTranscriptFrame {
  const row = record(value);
  requireValue(typeof row.frameId === 'string', 'history.frameId');
  const frameId = row.frameId;
  switch (row.kind) {
    case 'text':
      requireValue((row.role === 'user' || row.role === 'assistant') && typeof row.text === 'string', 'history.text');
      return { kind: 'text', role: row.role, text: row.text, frameId };
    case 'thinking':
      requireValue(typeof row.text === 'string', 'history.thinking');
      return { kind: 'thinking', text: row.text, frameId };
    case 'tool':
      requireValue(typeof row.name === 'string' && typeof row.state === 'string', 'history.tool');
      return { kind: 'tool', name: row.name, state: row.state, input: row.input, output: row.output, frameId, ...(typeof row.toolCallId === 'string' ? { toolCallId: row.toolCallId } : {}), ...(typeof row.error === 'string' ? { error: row.error } : {}) };
    case 'notice':
      requireValue(typeof row.message === 'string' && typeof row.level === 'string', 'history.notice');
      return { kind: 'notice', message: row.message, level: row.level, frameId };
    default: throw new Error('Unsupported Kimi transcript frame.');
  }
}
function kimiTurn(value: Record<string, unknown>): KimiWebTranscriptTurn {
  requireValue(typeof value.turnId === 'string' && typeof value.ordinal === 'number' && typeof value.state === 'string' && Array.isArray(value.steps), 'history.turn');
  return {
    kind: 'turn', turnId: value.turnId, ordinal: value.ordinal, state: value.state,
    ...(typeof value.triggerPromptId === 'string' ? { triggerPromptId: value.triggerPromptId } : {}),
    ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
    ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
    ...(typeof value.endedAt === 'string' ? { endedAt: value.endedAt } : {}),
    steps: value.steps.map(value => {
      const step = record(value);
      requireValue(typeof step.stepId === 'string' && Array.isArray(step.frames), 'history.step');
      const usage = step.usage === undefined ? undefined : record(step.usage);
      return { stepId: step.stepId, frames: step.frames.map(kimiFrame), ...(usage ? { usage: {
        inputOther: typeof usage.inputOther === 'number' ? usage.inputOther : 0,
        output: typeof usage.output === 'number' ? usage.output : 0,
        inputCacheRead: typeof usage.inputCacheRead === 'number' ? usage.inputCacheRead : 0,
        inputCacheCreation: typeof usage.inputCacheCreation === 'number' ? usage.inputCacheCreation : 0,
      } } : {}) };
    }),
  };
}

function kimiAgentTurn(turn: Record<string, unknown>): KimiWebTranscriptTurn {
  requireValue(typeof turn.turn_id === 'string' && Array.isArray(turn.items), 'history.agent_turn');
  const items = turn.items.map(record);
  const opener = items.find(item => item.type === 'user_message' && item.placement === 'opener' && typeof item.text === 'string');
  const frames = items.flatMap<Record<string, unknown>>(item => {
    if (item === opener) return [];
    const frameId = item.item_id;
    if (typeof frameId !== 'string') return [];
    if ((item.type === 'user_message' || item.type === 'assistant_message') && typeof item.text === 'string') {
      return [{ frameId, kind: 'text', role: item.type === 'user_message' ? 'user' : 'assistant', text: item.text }];
    }
    if (item.type === 'reasoning' && typeof item.text === 'string') return [{ frameId, kind: 'thinking', text: item.text }];
    if (item.type === 'tool_call' && typeof item.name === 'string') {
      return [{ frameId, kind: 'tool', name: item.name, state: item.stage ?? item.status ?? 'completed', toolCallId: item.tool_call_id, input: item.input, output: item.output }];
    }
    if (item.type === 'notification' && typeof item.body === 'string') {
      return [{ frameId, kind: 'notice', message: item.body, level: item.severity ?? 'info' }];
    }
    return [];
  });
  return kimiTurn({
    turnId: turn.turn_id, ordinal: turn.ordinal, state: turn.status, startedAt: turn.started_at, endedAt: turn.ended_at,
    prompt: opener?.text, triggerPromptId: Array.isArray(opener?.prompt_ids) ? opener.prompt_ids[0] : undefined,
    steps: [{ stepId: `${turn.turn_id}:items`, frames }],
  });
}

export function createNativeHistoryProjection(kind: HarnessKind, sessionId: string) {
  const codexItems = new Map<string, ReturnType<typeof normalizeCodexTurnsToHistory>>();
  const acp = createAcpSessionState({ id: sessionId, title: sessionId });
  const dsh = createDshNormalizer({ address: { kind: 'session', sessionId }, retainRecords: false });
  const dshEntries = new Map<string, { info: MessageInfo; parts: MessagePart[] }>();
  return (value: unknown): unknown[] => {
    const row = record(value);
    switch (kind) {
      case 'opencode':
        requireValue(record(row.info).sessionID === sessionId && Array.isArray(row.parts), 'history.opencode_scope');
        return [row];
      case 'codex': {
        requireValue(typeof row.turnId === 'string' && row.item !== undefined, 'history.codex_item');
        const item = record(row.item);
        requireValue(typeof item.id === 'string', 'history.codex_item_id');
        // Native archive pages arrive newest first. Keep canonical entries only,
        // then rebuild chronological parent links as older prompts arrive. A
        // continuation must never inherit a newer turn's prompt.
        codexItems.set(JSON.stringify([row.turnId, item.id]), normalizeCodexTurnsToHistory({ sessionId, turns: [{ id: row.turnId, items: [item], startedAt: row.startedAtMs, completedAt: row.completedAtMs }] }));
        let count = [...codexItems.values()].reduce((sum, entries) => sum + entries.length, 0);
        while (codexItems.size > 200 || count > 200) {
          const oldest = codexItems.keys().next();
          if (oldest.done) break;
          count -= codexItems.get(oldest.value)!.length;
          codexItems.delete(oldest.value);
        }
        let parentID = '';
        return [...codexItems.values()].reverse().flatMap(entries => entries.map(entry => {
          if (entry.info.role === 'user') { parentID = entry.info.id; return entry; }
          return { ...entry, info: { ...entry.info, parentID } };
        }));
      }
      case 'acp': {
        const update = parseSessionUpdateParams(row.params);
        requireValue(update !== null && update.sessionId === sessionId, 'history.acp_scope');
        applyAcpUpdate(acp, update.update, ++acp.clock, 'acp');
        if (acp.entries.length > 200) acp.entries.splice(0, acp.entries.length - 200);
        return acp.entries;
      }
      case 'dsh': {
        for (const op of dsh.ingest(value).ops) {
          switch (op.kind) {
            case 'message': {
              const previous = dshEntries.get(op.message.id);
              dshEntries.set(op.message.id, { info: op.message, parts: previous?.parts ?? [] });
              break;
            }
            case 'part': {
              const entry = dshEntries.get(op.part.messageID);
              if (entry) {
                const index = entry.parts.findIndex(part => part.id === op.part.id);
                if (index < 0) entry.parts.push(op.part); else entry.parts[index] = op.part;
              }
              break;
            }
            default: break;
          }
        }
        while (dshEntries.size > 200) {
          const oldest = dshEntries.keys().next();
          if (oldest.done) break;
          dshEntries.delete(oldest.value);
        }
        return [...dshEntries.values()];
      }
      case 'kimi-web': {
        if (row.kind !== 'turn' && typeof row.turn_id !== 'string') return [];
        const turn = typeof row.turn_id === 'string' ? kimiAgentTurn(row) : kimiTurn(row);
        const entries = kimiWebTranscriptToHistoryEntries(sessionId, { agent_id: 'main', items: [turn], has_more: false });
        for (const entry of entries) entry.info.agent = 'main';
        if (turn.prompt) {
          const id = turn.triggerPromptId ?? `${sessionId}:transcript:${turn.turnId}:user`;
          entries.unshift({ info: { id, sessionID: sessionId, role: 'user', time: { created: Date.parse(turn.startedAt ?? '') || 0 }, agent: '', model: { providerID: '', modelID: '' } }, parts: [{ id: `${id}:text`, sessionID: sessionId, messageID: id, type: 'text', text: turn.prompt }] });
          for (const entry of entries) if (entry.info.role === 'assistant') entry.info.parentID = id;
        }
        return entries;
      }
    }
  };
}
