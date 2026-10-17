import { ProtocolError } from '../../shared/runtime/protocol.js';

export function createConnectionScope() {
  const connections = new Map();
  let generation = 0;
  let closed = false;
  return {
    connect(id) {
      if (closed) throw new ProtocolError('cancelled', 'connection.closed');
      const current = ++generation;
      connections.set(id, current);
      return {
        generation: current,
        assertCurrent() {
          if (closed || connections.get(id) !== current)
            throw new ProtocolError('reconcile_required', 'connection.generation');
        },
        disconnect() {
          if (connections.get(id) === current) connections.delete(id);
        },
      };
    },
    get size() {
      return connections.size;
    },
    close() {
      closed = true;
      connections.clear();
    },
  };
}
