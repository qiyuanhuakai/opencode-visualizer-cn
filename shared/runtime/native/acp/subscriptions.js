import { AcpError } from './capabilities.js';
import { encodeSessionKey } from '../../identity.js';
import { jsonValue } from '../../capabilities.js';
import { text } from './capabilities.js';

export function createAcpSubscriptions(binding) {
  const observers = new Map();
  const events = [];
  let sequence = 0;
  let bytes = 0;
  let floor = 0;
  let active = true;
  function emit(input) {
    if (!active) return;
    const event = jsonValue({ ...input, ...binding, sequence: ++sequence });
    const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (size > 262144) {
      floor = sequence;
      events.length = 0;
      bytes = 0;
      return;
    }
    events.push({ event, size });
    bytes += size;
    while (events.length > 128 || bytes > 1048576) {
      const removed = events.shift();
      floor = removed.event.sequence;
      bytes -= removed.size;
    }
  }
  function subscribe({ subscriberId, session, after = sequence }) {
    text(subscriberId);
    if (!active) throw new AcpError('reconcile_required', 'stale_generation');
    if (observers.has(subscriberId)) throw new AcpError('conflict', 'subscriber_id');
    if (observers.size >= 128) throw new AcpError('source_unavailable', 'subscriber_limit');
    if (!Number.isSafeInteger(after) || after < 0 || after > sequence)
      throw new AcpError('invalid_request', 'event_cursor');
    const token = { active: true, cursor: after };
    observers.set(subscriberId, token);
    return {
      read() {
        if (!token.active || !active) throw new AcpError('reconcile_required', 'subscriber_closed');
        const result = events
          .filter(
            ({ event }) =>
              event.sequence > token.cursor &&
              (!session ||
                !event.session ||
                encodeSessionKey(event.session) === encodeSessionKey(session)),
          )
          .map(({ event }) => event);
        const partial = token.cursor < floor;
        token.cursor = sequence;
        return {
          events: result,
          through: sequence,
          floor,
          status: partial ? 'partial' : 'complete',
        };
      },
      detach() {
        token.active = false;
        if (observers.get(subscriberId) === token) observers.delete(subscriberId);
      },
    };
  }
  return {
    emit,
    subscribe,
    get count() {
      return observers.size;
    },
    close() {
      active = false;
      for (const token of observers.values()) token.active = false;
      observers.clear();
      events.length = 0;
      bytes = 0;
    },
  };
}
