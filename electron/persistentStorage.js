import fs from 'node:fs';
import path from 'node:path';

function readStore(filePath, fileSystem) {
  let source;
  try {
    const bytes = fileSystem.readFileSync(filePath);
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(source);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== 'string')
  ) {
    throw new TypeError('Persistent storage must be an object of string values');
  }
  return { ...parsed };
}

function writeStore(filePath, storage, fileSystem) {
  const directory = path.dirname(filePath);
  const temporaryFilePath = `${filePath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  fileSystem.mkdirSync(directory, { recursive: true });
  const mode = fileSystem.existsSync(filePath) ? fileSystem.statSync(filePath).mode & 0o777 : 0o600;
  try {
    fileSystem.writeFileSync(temporaryFilePath, JSON.stringify(storage, null, 2), {
      encoding: 'utf8',
      mode,
    });
    const descriptor = fileSystem.openSync(temporaryFilePath, 'r+');
    try {
      fileSystem.fsyncSync(descriptor);
    } finally {
      fileSystem.closeSync(descriptor);
    }
    fileSystem.renameSync(temporaryFilePath, filePath);
    if (process.platform !== 'win32') {
      const directoryDescriptor = fileSystem.openSync(directory, 'r');
      try {
        fileSystem.fsyncSync(directoryDescriptor);
      } finally {
        fileSystem.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    fileSystem.rmSync(temporaryFilePath, { force: true });
    throw error;
  }
}

export function createPersistentStorage(filePath, fileSystem = fs) {
  let cache = null;
  let durabilityPending = false;
  let publishedStorage = null;

  const load = () => {
    if (cache === null) {
      cache = readStore(filePath, fileSystem);
      publishedStorage ??= { ...cache };
    }
    return cache;
  };

  return {
    getItem(key) {
      const storage = load();
      return Object.hasOwn(storage, key) ? storage[key] : null;
    },
    setItem(key, value) {
      const storage = load();
      const oldValue = Object.hasOwn(storage, key) ? storage[key] : null;
      if (oldValue === value && !durabilityPending) return oldValue;
      const nextStorage = { ...storage, [key]: value };
      try {
        writeStore(filePath, nextStorage, fileSystem);
      } catch (error) {
        cache = null;
        durabilityPending = true;
        throw error;
      }
      cache = nextStorage;
      durabilityPending = false;
      return oldValue;
    },
    removeItem(key) {
      const storage = load();
      const oldValue = Object.hasOwn(storage, key) ? storage[key] : null;
      if (oldValue === null && !durabilityPending) return null;
      const nextStorage = { ...storage };
      delete nextStorage[key];
      try {
        writeStore(filePath, nextStorage, fileSystem);
      } catch (error) {
        cache = null;
        durabilityPending = true;
        throw error;
      }
      cache = nextStorage;
      durabilityPending = false;
      return oldValue;
    },
    migrate(entries) {
      const storage = load();
      const nextStorage = { ...storage };
      const changes = [];
      for (const [key, value] of Object.entries(entries)) {
        if (Object.hasOwn(storage, key)) continue;
        nextStorage[key] = value;
        changes.push({ key, oldValue: null, newValue: value });
      }
      if (changes.length === 0 && !durabilityPending) return changes;
      try {
        writeStore(filePath, nextStorage, fileSystem);
      } catch (error) {
        cache = null;
        durabilityPending = true;
        throw error;
      }
      cache = nextStorage;
      durabilityPending = false;
      return changes;
    },
    drainPendingChanges() {
      if (durabilityPending) return [];
      const storage = load();
      const changes = [];
      const keys = new Set([...Object.keys(publishedStorage), ...Object.keys(storage)]);
      for (const key of keys) {
        const oldValue = Object.hasOwn(publishedStorage, key) ? publishedStorage[key] : null;
        const newValue = Object.hasOwn(storage, key) ? storage[key] : null;
        if (oldValue !== newValue) changes.push({ key, oldValue, newValue });
      }
      publishedStorage = { ...storage };
      return changes;
    },
  };
}
