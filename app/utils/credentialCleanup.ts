type CredentialCleanupOptions = {
  disconnect: () => void;
  clear: (expectedRevision: string | null) => 'cleared' | 'already-cleared' | 'failed' | 'stale';
  confirmRetry: () => Promise<boolean>;
  runExclusive: <T>(operation: () => Promise<T> | T) => Promise<T>;
};

const CREDENTIAL_MUTATION_LOCK = 'vis:credential-mutation';
let fallbackMutationTail = Promise.resolve();

export function runCredentialMutationExclusive<T>(operation: () => Promise<T> | T) {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(CREDENTIAL_MUTATION_LOCK, () => operation());
  }
  const current = fallbackMutationTail.then(operation, operation);
  fallbackMutationTail = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export function createSingleFlightCredentialCleanup(options: CredentialCleanupOptions) {
  const inFlightByRevision = new Map<string | null, Promise<boolean>>();

  return function cleanup(expectedRevision: string | null) {
    const existing = inFlightByRevision.get(expectedRevision);
    if (existing) return existing;

    const current = options.runExclusive(async () => {
      let disconnected = false;
      for (;;) {
        const result = options.clear(expectedRevision);
        if (result === 'stale') return false;
        if (!disconnected) {
          options.disconnect();
          disconnected = true;
        }
        if (result === 'cleared' || result === 'already-cleared') return true;
        if (!(await options.confirmRetry())) return false;
      }
    });
    inFlightByRevision.set(expectedRevision, current);
    void current.then(
      () => {
        if (inFlightByRevision.get(expectedRevision) === current) {
          inFlightByRevision.delete(expectedRevision);
        }
      },
      () => {
        if (inFlightByRevision.get(expectedRevision) === current) {
          inFlightByRevision.delete(expectedRevision);
        }
      },
    );
    return current;
  };
}
