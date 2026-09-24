export async function cleanupAsyncQuitOwners(localFileEditor, desktopRuntime) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => localFileEditor.closeAll()),
    Promise.resolve().then(() => desktopRuntime?.dispose()),
  ]);
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Desktop cleanup failed');
  return [undefined, undefined];
}

export function installAsyncQuitCleanup(app, cleanup, onError = () => {}) {
  let cleanupPromise = null;
  let quittingAfterCleanup = false;

  app.on('before-quit', (event) => {
    if (quittingAfterCleanup) return;
    event.preventDefault();
    if (cleanupPromise) return;

    cleanupPromise = Promise.resolve()
      .then(cleanup)
      .then(() => {
        quittingAfterCleanup = true;
        app.quit();
      })
      .catch((error) => {
        quittingAfterCleanup = true;
        try {
          onError(error);
        } catch {
        } finally {
          app.quit();
        }
      });
  });
}
