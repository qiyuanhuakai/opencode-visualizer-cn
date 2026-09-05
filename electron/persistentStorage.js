import fs from 'node:fs';
import path from 'node:path';

function readStore(filePath, fileSystem) {
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
      );
    }
  } catch {
    return {};
  }
  return {};
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
  } catch (error) {
    fileSystem.rmSync(temporaryFilePath, { force: true });
    throw error;
  }
}

export function createPersistentStorage(filePath, fileSystem = fs) {
  let cache = null;

  const load = () => {
    cache ??= readStore(filePath, fileSystem);
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
      const nextStorage = { ...storage, [key]: value };
      writeStore(filePath, nextStorage, fileSystem);
      cache = nextStorage;
      return oldValue;
    },
    removeItem(key) {
      const storage = load();
      const oldValue = Object.hasOwn(storage, key) ? storage[key] : null;
      if (oldValue === null) return null;
      const nextStorage = { ...storage };
      delete nextStorage[key];
      writeStore(filePath, nextStorage, fileSystem);
      cache = nextStorage;
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
      if (changes.length === 0) return changes;
      writeStore(filePath, nextStorage, fileSystem);
      cache = nextStorage;
      return changes;
    },
  };
}
