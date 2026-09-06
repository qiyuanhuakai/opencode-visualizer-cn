export function createBridgeUpdateSession({ isPackaged, isDisposed, onVersionChange, runCheck }) {
  let connectionId = null;
  let version = null;
  let revision = 0;
  let autoCheck = false;
  let pendingAutoCheck = false;
  let activeWork = null;
  let drainPromise = null;

  function capture(component) {
    return component === 'bridge' ? revision : null;
  }

  function isCurrent(component, capturedRevision) {
    return component !== 'bridge' || capturedRevision === revision;
  }

  function report(next) {
    if (next.connectionId === connectionId && next.version === version) return false;
    connectionId = next.connectionId;
    version = next.version;
    revision += 1;
    onVersionChange(version);
    if (canAutoCheck()) requestAutoCheck();
    return true;
  }

  function configure(enabled, waitForVersion) {
    autoCheck = enabled;
    if (!enabled) pendingAutoCheck = false;
    else if (waitForVersion) pendingAutoCheck = true;
  }

  function track(component, promise) {
    if (component !== 'bridge') return;
    activeWork = promise;
    const clear = () => {
      if (activeWork === promise) activeWork = null;
    };
    void promise.then(clear, clear);
  }

  function requestAutoCheck() {
    pendingAutoCheck = true;
    if (drainPromise !== null || !canAutoCheck()) return;
    drainPromise = drainAutoCheck()
      .catch(() => undefined)
      .finally(() => {
        drainPromise = null;
        if (pendingAutoCheck && canAutoCheck()) requestAutoCheck();
      });
  }

  function canAutoCheck() {
    return autoCheck && isPackaged && version !== null && !isDisposed();
  }

  async function drainAutoCheck() {
    while (pendingAutoCheck && canAutoCheck()) {
      const running = activeWork;
      if (running !== null) await running.catch(() => undefined);
      if (!pendingAutoCheck || !canAutoCheck()) return;
      pendingAutoCheck = false;
      await runCheck();
    }
  }

  return { capture, configure, isCurrent, report, track };
}
