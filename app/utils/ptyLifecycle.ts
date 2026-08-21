export function createPendingPtyCreateRegistry<T>() {
  const pending = new Map<string, Promise<T>>();
  const generations = new Map<string, number>();

  function get(id: string) {
    return pending.get(id);
  }

  function getOrCreate(id: string, factory: (isCurrent: () => boolean) => Promise<T>) {
    const existing = pending.get(id);
    if (existing) return existing;

    const generation = generations.get(id) ?? 0;
    let entry: Promise<T>;
    const isCurrent = () =>
      generations.get(id) === generation && pending.get(id) === entry;
    const created = factory(isCurrent);
    entry = created;
    pending.set(id, created);
    const clear = () => {
      if (pending.get(id) === created) pending.delete(id);
    };
    void created.then(clear, clear);
    return created;
  }

  function invalidate(id: string) {
    generations.set(id, (generations.get(id) ?? 0) + 1);
    pending.delete(id);
  }

  function invalidateAll() {
    for (const id of pending.keys()) invalidate(id);
    pending.clear();
  }

  return { get, getOrCreate, invalidate, invalidateAll };
}

export function isCurrentPtySocket<Session extends { socket?: Socket }, Socket>(
  sessions: Map<string, Session>,
  ptyId: string,
  session: Session,
  socket: Socket,
) {
  return sessions.get(ptyId) === session && session.socket === socket;
}
