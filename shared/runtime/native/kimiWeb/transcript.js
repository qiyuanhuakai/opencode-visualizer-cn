import { ProtocolError, jsonValue } from '../../capabilities.js';
import { record, nativeInteger, nativeText } from './protocol.js';

function idOf(item) { return item.turnId ?? item.markerId ?? item.refId; }
function upsert(items, value, key, merge = true) {
  const id = nativeText(value[key], 'transcript_identity', 512);
  const index = items.findIndex((item) => item[key] === id);
  if (index < 0) return [...items, value];
  return items.map((item, i) => i === index ? (merge ? { ...item, ...value } : value) : item);
}
export function transcriptSnapshot(value) {
  const source = record(jsonValue(value), 'transcript_snapshot');
  if (!Array.isArray(source.items) || source.items.length > 200)
    throw new ProtocolError('replay_required', 'transcript_page_size');
  for (const item of source.items) nativeText(idOf(record(item)), 'transcript_item_id', 512);
  return {
    items: source.items,
    tasks: source.tasks ?? [], interactions: source.interactions ?? [], attachments: source.attachments ?? [],
    todos: source.todos ?? [], prompts: source.prompts ?? [], meta: source.meta ?? {}, agents: source.agents ?? [],
    hasMoreOlder: source.hasMoreOlder === true || source.has_more === true,
  };
}
export function transcriptPage(value, previousCursor) {
  const source = record(value, 'transcript_page');
  if (typeof source.has_more !== 'boolean') throw new ProtocolError('invalid_request', 'transcript_has_more');
  const snapshot = transcriptSnapshot(source);
  nativeInteger(source.seq, 'transcript_seq');
  const cursor = source.has_more ? source.items.find((item) => item.kind === 'turn')?.turnId : null;
  if (source.has_more && (!cursor || cursor === previousCursor)) throw new ProtocolError('replay_required', 'transcript_cursor');
  return { ...snapshot, seq: source.seq, cursor, completeness: source.has_more ? 'partial' : 'complete' };
}
function updateFrame(state, target, change) {
  let found = false;
  const items = state.items.map((turn) => {
    if (turn.turnId !== target.turnId) return turn;
    return { ...turn, steps: (turn.steps ?? []).map((step) => {
      if (step.stepId !== target.stepId) return step;
      return { ...step, frames: (step.frames ?? []).map((frame) => {
        if (frame.frameId !== target.frameId) return frame;
        found = true; return change(frame);
      }) };
    }) };
  });
  if (!found) throw new ProtocolError('replay_required', 'transcript_missing_frame');
  return { ...state, items };
}
export function applyTranscriptOps(previous, operations) {
  if (!Array.isArray(operations) || operations.length > 1000) throw new ProtocolError('invalid_request', 'transcript_ops');
  let state = previous;
  for (const raw of operations) {
    const op = record(raw, 'transcript_operation');
    switch (op.op) {
      case 'reset': state = transcriptSnapshot(op.snapshot); break;
      case 'turn.upsert': {
        const turn = record(op.turn);
        const old = state.items.find((candidate) => candidate.turnId === turn.turnId);
        state = { ...state, items: upsert(state.items, { ...turn, steps: old?.steps ?? [] }, 'turnId') }; break;
      }
      case 'step.upsert': {
        let found = false;
        state = { ...state, items: state.items.map((turn) => {
          if (turn.turnId !== op.turnId) return turn;
          found = true;
          const old = (turn.steps ?? []).find((step) => step.stepId === op.step?.stepId);
          return { ...turn, steps: upsert(turn.steps ?? [], { frames: old?.frames ?? [], ...record(op.step) }, 'stepId') };
        }) };
        if (!found) throw new ProtocolError('replay_required', 'transcript_missing_turn');
        break;
      }
      case 'frame.upsert': {
        let found = false;
        state = { ...state, items: state.items.map((turn) => turn.turnId !== op.turnId ? turn : {
          ...turn, steps: (turn.steps ?? []).map((step) => {
            if (step.stepId !== op.stepId) return step;
            found = true; return { ...step, frames: upsert(step.frames ?? [], record(op.frame), 'frameId', false) };
          }),
        }) };
        if (!found) throw new ProtocolError('replay_required', 'transcript_missing_step');
        break;
      }
      case 'append': {
        const target = record(op.target);
        nativeInteger(op.offset, 'transcript_append_offset');
        if (typeof op.text !== 'string') throw new ProtocolError('invalid_request', 'transcript_append_text');
        const append = (text) => {
          if (typeof text !== 'string' || op.offset > text.length) throw new ProtocolError('replay_required', 'transcript_append_gap');
          if (text.slice(op.offset) && !op.text.startsWith(text.slice(op.offset)) && !text.slice(op.offset).startsWith(op.text))
            throw new ProtocolError('replay_required', 'transcript_append_conflict');
          return text.length >= op.offset + op.text.length ? text : text.slice(0, op.offset) + op.text;
        };
        if (target.type === 'task') {
          let found = false;
          state = { ...state, tasks: state.tasks.map((task) => {
            if (task.taskId !== target.taskId) return task;
            found = true; return { ...task, output: append(task.output ?? '') };
          }) };
          if (!found) throw new ProtocolError('replay_required', 'transcript_missing_task');
        } else if (target.type === 'frame') {
          state = updateFrame(state, target, (frame) => ({ ...frame, text: append(frame.text ?? '') }));
        } else throw new ProtocolError('unsupported', 'transcript_append_target');
        break;
      }
      case 'marker.upsert': case 'taskref.upsert': {
        const item = record(op.item); const key = op.op === 'marker.upsert' ? 'markerId' : 'refId';
        const existing = state.items.findIndex((candidate) => candidate[key] === item[key]);
        let items = upsert(state.items, item, key, false);
        if (existing < 0 && Number.isSafeInteger(op.beforeTurn)) {
          items = items.slice(0, -1);
          const index = items.findIndex((candidate) => candidate.kind === 'turn' && candidate.ordinal >= op.beforeTurn);
          items.splice(index < 0 ? items.length : index, 0, item);
        }
        state = { ...state, items }; break;
      }
      case 'task.upsert': case 'interaction.upsert': case 'attachment.upsert': case 'todo.upsert': case 'prompt.upsert': {
        const name = op.op.split('.')[0];
        const field = `${name}s`, key = `${name}Id`;
        state = { ...state, [field]: upsert(state[field], record(op[name]), key) }; break;
      }
      case 'meta.merge': {
        const patch = record(op.meta);
        const meta = { ...state.meta, ...patch };
        if (patch.agent !== undefined) meta.agent = { ...state.meta.agent, ...record(patch.agent) };
        if (patch.goal === null) delete meta.goal;
        if (patch.modes !== undefined) {
          meta.modes = { ...state.meta.modes, ...record(patch.modes) };
          for (const key of Object.keys(meta.modes)) if (meta.modes[key] === null) delete meta.modes[key];
          if (!Object.keys(meta.modes).length) delete meta.modes;
        }
        state = { ...state, meta }; break;
      }
      case 'items.remove': {
        if (!Array.isArray(op.ids) || op.ids.some((id) => typeof id !== 'string')) throw new ProtocolError('invalid_request', 'transcript_remove');
        state = { ...state, items: state.items.filter((item) => !op.ids.includes(idOf(item))) }; break;
      }
      default: throw new ProtocolError('unsupported', 'transcript_operation');
    }
  }
  return state;
}
export function mergeOlderTranscript(current, older) {
  const known = new Set(current.items.map(idOf));
  return { ...current, items: [...older.items.filter((item) => !known.has(idOf(item))), ...current.items], hasMoreOlder: older.hasMoreOlder };
}
