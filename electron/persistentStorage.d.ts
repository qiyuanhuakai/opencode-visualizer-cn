export type PersistentStorage = {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => string | null;
  readonly removeItem: (key: string) => string | null;
  readonly migrate: (entries: Readonly<Record<string, string>>) => Array<{
    key: string;
    oldValue: null;
    newValue: string;
  }>;
  readonly update: (entries: Readonly<Record<string, string | null>>) => Array<{
    key: string;
    oldValue: string | null;
    newValue: string | null;
  }>;
};

export function createPersistentStorage(filePath: () => string): PersistentStorage;
