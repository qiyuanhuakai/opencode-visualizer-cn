import { ProtocolError } from '../../shared/runtime/protocol.js';

export function createResourceOwnership() {
  const resources = new Map();
  let releasePromise;
  return {
    register(id, ownership, release) {
      if (releasePromise) throw new ProtocolError('cancelled', 'resources.closed');
      if (resources.has(id)) throw new ProtocolError('conflict', 'resources.id');
      if (ownership !== 'owned' && ownership !== 'borrowed')
        throw new ProtocolError('invalid_request', 'resources.ownership');
      resources.set(id, { ownership, release });
    },
    release() {
      releasePromise ??= (async () => {
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
        if (failures.length) {
          releasePromise = undefined;
          throw new AggregateError(failures, 'Runtime resource release failed.');
        }
      })();
      return releasePromise;
    },
  };
}
