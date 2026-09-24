import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HISTORY_PREFIX = 'opencode.state.codexAuxiliaryHistory.v1.';

async function writeStoreAsync(filePath, storage, fileSystem = fs) {
  const io = fileSystem.promises ?? fs.promises;
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  await io.mkdir(directory, { recursive: true });
  let mode = 0o600;
  try {
    mode = (await io.stat(filePath)).mode & 0o777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    const file = await io.open(temporary, 'wx', mode);
    try {
      await file.writeFile(JSON.stringify(storage));
      await file.sync();
    } finally {
      await file.close();
    }
    await io.rename(temporary, filePath);
    if (process.platform !== 'win32') {
      const directoryHandle = await io.open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    await io.rm(temporary, { force: true });
    throw error;
  }
}

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

function createFlatStorage(filePath, fileSystem = fs) {
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
    async setItemAsync(key, value) {
      const storage = load();
      const oldValue = Object.hasOwn(storage, key) ? storage[key] : null;
      if (oldValue === value && !durabilityPending) return oldValue;
      const nextStorage = { ...storage };
      if (value === null) delete nextStorage[key];
      else nextStorage[key] = value;
      try {
        await writeStoreAsync(filePath, nextStorage, fileSystem);
      } catch (error) {
        cache = null;
        durabilityPending = true;
        throw error;
      }
      cache = nextStorage;
      durabilityPending = false;
      return oldValue;
    },
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

export function createPersistentStorage(filePath, fileSystem = fs) {
  let root = null;
  let preparation = null;
  let preparationFailure = null;
  const shards = new Map();
  const writes = new Map();
  const queuedValues = new Map();
  const shardPath = (key) => path.join(`${filePath}.history`, `${createHash('sha256').update(key).digest('hex')}.json`);
  const shard = (key) => {
    if (!shards.has(key)) shards.set(key, createFlatStorage(shardPath(key), fileSystem));
    return shards.get(key);
  };
  const prepareSync = () => {
    if (root) return;
    if (preparation) throw new Error('Persistent storage migration is in progress');
    const entries = readStore(filePath, fileSystem);
    const keys = Object.keys(entries).filter((key) => key.startsWith(HISTORY_PREFIX));
    for (const key of keys) {
      // The original remains authoritative until every copied file is durable.
      writeStore(shardPath(key), { [key]: entries[key] }, fileSystem);
      delete entries[key];
    }
    if (keys.length) writeStore(filePath, entries, fileSystem);
    root = createFlatStorage(filePath, fileSystem);
  };
  const target = (key) => {
    prepareSync();
    if (preparationFailure) return root;
    return key.startsWith(HISTORY_PREFIX) ? shard(key) : root;
  };
  return {
    prepare() {
      if (root && !preparationFailure) return Promise.resolve();
      if (preparation) return preparation;
      preparation = (async () => {
        const entries = readStore(filePath, fileSystem);
        const keys = Object.keys(entries).filter((key) => key.startsWith(HISTORY_PREFIX));
        for (const key of keys) {
          await writeStoreAsync(shardPath(key), { [key]: entries[key] }, fileSystem);
          delete entries[key];
        }
        if (keys.length) await writeStoreAsync(filePath, entries, fileSystem);
        root = createFlatStorage(filePath, fileSystem);
        preparationFailure = null;
      })().catch((error) => {
        preparationFailure = error;
        root = createFlatStorage(filePath, fileSystem);
        throw error;
      }).finally(() => { preparation = null; });
      return preparation;
    },
    getItem(key) {
      const value = target(key).getItem(key);
      if (preparationFailure && value === null && key.startsWith(HISTORY_PREFIX)) return shard(key).getItem(key);
      return value;
    },
    setItem(key, value) {
      if (preparationFailure) throw preparationFailure;
      if (writes.has(key)) throw new Error('Auxiliary history has an asynchronous write in progress');
      return target(key).setItem(key, value);
    },
    removeItem(key) {
      if (preparationFailure) throw preparationFailure;
      if (writes.has(key)) throw new Error('Auxiliary history has an asynchronous write in progress');
      return target(key).removeItem(key);
    },
    setItemAsync(key, value) {
      if (!key.startsWith(HISTORY_PREFIX)) return Promise.reject(new TypeError('Async storage is restricted to auxiliary history'));
      queuedValues.set(key, value);
      if (writes.has(key)) return writes.get(key);
      const operation = (async () => {
        await this.prepare();
        let oldValue = null;
        while (queuedValues.has(key)) {
          const nextValue = queuedValues.get(key);
          queuedValues.delete(key);
          oldValue = await shard(key).setItemAsync(key, nextValue);
        }
        return oldValue;
      })();
      writes.set(key, operation);
      const clear = () => {
        if (writes.get(key) === operation) {
          writes.delete(key);
          queuedValues.delete(key);
        }
      };
      void operation.then(clear, clear);
      return operation;
    },
    async flush() {
      const failures = [];
      while (writes.size) {
        const results = await Promise.allSettled(writes.values());
        for (const result of results) {
          if (result.status === 'rejected') failures.push(result.reason);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Auxiliary history writes failed');
    },
    migrate(entries) {
      if (preparationFailure) throw preparationFailure;
      prepareSync();
      const smallEntries = {};
      const changes = [];
      for (const [key, value] of Object.entries(entries)) {
        if (writes.has(key)) throw new Error('Auxiliary history has an asynchronous write in progress');
        if (key.startsWith(HISTORY_PREFIX)) changes.push(...shard(key).migrate({ [key]: value }));
        else smallEntries[key] = value;
      }
      return [...changes, ...root.migrate(smallEntries)];
    },
    drainPendingChanges() {
      prepareSync();
      return [...root.drainPendingChanges(), ...Array.from(shards.values()).flatMap((storage) => storage.drainPendingChanges())];
    },
  };
}
