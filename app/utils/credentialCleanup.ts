type CredentialCleanupOptions = {
  disconnect: () => void;
  clear: () => boolean;
  confirmRetry: () => Promise<boolean>;
};

export function createSingleFlightCredentialCleanup(options: CredentialCleanupOptions) {
  let inFlight: Promise<boolean> | null = null;

  return function cleanup() {
    if (inFlight) return inFlight;

    const current = (async () => {
      options.disconnect();
      while (!options.clear()) {
        if (!(await options.confirmRetry())) return false;
      }
      return true;
    })();
    inFlight = current;
    void current.then(
      () => {
        if (inFlight === current) inFlight = null;
      },
      () => {
        if (inFlight === current) inFlight = null;
      },
    );
    return current;
  };
}
