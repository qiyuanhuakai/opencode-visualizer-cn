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
