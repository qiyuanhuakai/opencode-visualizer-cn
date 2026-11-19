import { ProtocolError } from '../../shared/runtime/protocol.js';

export function createResourceOwnership() {
  const resources = new Map();
  let closed = false;
  let releasePromise;
  return {
    register(id, ownership, release) {
      if (closed) throw new ProtocolError('cancelled', 'resources.closed');
      if (resources.has(id)) throw new ProtocolError('conflict', 'resources.id');
      if (ownership !== 'owned' && ownership !== 'borrowed')
        throw new ProtocolError('invalid_request', 'resources.ownership');
      resources.set(id, { ownership, release });
    },
    release() {
      closed = true;
      if (!releasePromise) {
        const attempt = (async () => {
          const failures = [];
          for (const [id, resource] of [...resources].reverse()) {
            if (resource.ownership === 'borrowed') continue;
            try {
              await resource.release();
              resources.delete(id);
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length) throw new AggregateError(failures, 'Runtime resource release failed.');
        })();
        // Retain failed resources for a later attempt, including a synchronous
        // throw before the first await. Admission remains permanently closed.
        attempt.catch(() => {
          if (releasePromise === attempt) releasePromise = undefined;
        });
        releasePromise = attempt;
      }
      return releasePromise;
    },
  };
}
