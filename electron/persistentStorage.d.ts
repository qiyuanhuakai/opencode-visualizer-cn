export type PersistentStorage = {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => string | null;
  readonly removeItem: (key: string) => string | null;
  readonly migrate: (entries: Readonly<Record<string, string>>) => Array<{
    key: string;
    oldValue: null;
    newValue: string;
  }>;
};

export function createPersistentStorage(filePath: () => string): PersistentStorage;
