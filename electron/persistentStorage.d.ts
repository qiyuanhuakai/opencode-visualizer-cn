export type PersistentStorageChange = Readonly<{
  key: string;
  oldValue: string | null;
  newValue: string | null;
}>;

export interface PersistentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): string | null;
  removeItem(key: string): string | null;
  migrate(entries: Readonly<Record<string, string>>): readonly PersistentStorageChange[];
  drainPendingChanges(): readonly PersistentStorageChange[];
}

export interface PersistentStorageFileSystem {
  readFileSync(filePath: string, encoding: 'utf8'): string;
  writeFileSync(
    filePath: string,
    data: string,
    options: Readonly<{ encoding: 'utf8'; mode: number }>,
  ): void;
  mkdirSync(directory: string, options: Readonly<{ recursive: true }>): unknown;
  existsSync(filePath: string): boolean;
  statSync(filePath: string): Readonly<{ mode: number }>;
  openSync(filePath: string, flags: string): number;
  fsyncSync(descriptor: number): void;
  closeSync(descriptor: number): void;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(filePath: string, options: Readonly<{ force: true }>): void;
}

export function createPersistentStorage(
  filePath: string,
  fileSystem?: PersistentStorageFileSystem,
): PersistentStorage;
