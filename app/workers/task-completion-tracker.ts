import type { SsePacket } from '../types/sse';
import { asRecord } from './sse-state-packet';

export function createTaskCompletionTracker(resolveRoot: (directory: string | undefined, sessionId: string) =>
  readonly [projectId: string, rootSessionId: string] | null) {
  const pending = new Map<string, string | null>();
  const keyOf = (projectId: string, sessionId: string) => `${projectId}\0${sessionId}`;
  return {
    observe(packet: SsePacket) {
      const properties = asRecord(packet.payload.properties);
      if (!properties) return;
      const info = asRecord(properties.info);
      const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : info?.sessionID;
      if (typeof sessionId !== 'string') return;
      const root = resolveRoot(packet.directory, sessionId);
      if (!root) return;
      const [projectId, rootSessionId] = root;
      const key = keyOf(projectId, rootSessionId);
      switch (packet.payload.type) {
        case 'session.status': {
          const status = asRecord(properties.status)?.type;
          if ((status === 'busy' || status === 'retry') && !pending.has(key)) {
            pending.set(key, null);
            if (pending.size > 1000) {
              const [oldest] = pending.keys();
              if (oldest) pending.delete(oldest);
            }
          }
          break;
        }
        case 'session.error': {
          pending.delete(key);
          break;
        }
        case 'message.updated': {
          if (!pending.has(key) || sessionId !== rootSessionId || info?.role !== 'assistant') return;
          if (info.error) { pending.delete(key); return; }
          const completed = asRecord(info.time)?.completed;
          if (typeof completed === 'number' && typeof info.id === 'string' && info.finish !== 'tool-calls') {
            pending.set(key, info.id);
          }
          break;
        }
      }
    },
    consume(projectId: string, sessionId: string) {
      const key = keyOf(projectId, sessionId);
      const entry = pending.get(key);
      pending.delete(key);
      return entry ?? undefined;
    },
    clear() { pending.clear(); },
  };
}
