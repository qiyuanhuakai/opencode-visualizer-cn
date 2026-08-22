export type PersistentStorage = {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => string | null;
  readonly removeItem: (key: string) => string | null;
};

export function createPersistentStorage(filePath: () => string): PersistentStorage;
