export function createKeyedTaskQueue() {
  const chains = new Map<string, Promise<void>>();

  async function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.then(() => undefined, () => undefined);
    chains.set(key, settled);
    try {
      return await result;
    } finally {
      if (chains.get(key) === settled) chains.delete(key);
    }
  }

  return { run };
}
