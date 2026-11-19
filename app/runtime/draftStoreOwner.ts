/** One connection and recovery queue for an App lifetime, including late opens. */
export function createDraftStoreOwner<S extends { close(): void | Promise<void> }>(open: () => Promise<S>) {
  let opening: Promise<S> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const unavailable = () => new Error('Draft storage is closed');
  return {
    get(): Promise<S> {
      if (closed) return Promise.reject(unavailable());
      opening ??= Promise.resolve().then(() => {
        if (closed) throw unavailable();
        return open();
      }).catch(error => { opening = undefined; throw error; });
      return opening.then(store => { if (closed) throw unavailable(); return store; });
    },
    close(after?: Promise<unknown>): Promise<void> {
      closed = true;
      closing ??= Promise.resolve().then(async () => {
        // A failed edit/import still has to settle before its connection closes.
        await after?.catch(() => undefined);
        const store = await opening?.catch(() => undefined);
        await store?.close();
      }).catch(error => { closing = undefined; throw error; });
      return closing;
    },
  };
}
