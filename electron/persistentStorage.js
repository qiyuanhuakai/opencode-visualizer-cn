import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE_MIGRATION_KEYS = new Set([
  'opencode.credentials.v1',
  'opencode.auth.credentials.v1',
  'opencode.auth.codexBridgeToken.v1',
  'opencode.auth.acpBridgeToken.v1',
]);

export function createPersistentStorage(filePath) {
  let cache = null;
  let hasNativeAuthority = false;
  let temporaryFileSequence = 0;

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
      hasNativeAuthority = true;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cache = Object.fromEntries(
          Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
        );
        return cache;
      }
    } catch (error) {
      hasNativeAuthority = error?.code !== 'ENOENT';
    }
    const empty = {};
    cache = empty;
    return empty;
  }

  function commit(next) {
    const target = filePath();
    const temporary = `${target}.tmp-${process.pid}-${temporaryFileSequence++}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), {
        encoding: 'utf8',
        flush: true,
        mode: 0o600,
      });
      fs.renameSync(temporary, target);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    cache = next;
    hasNativeAuthority = true;
  }

  return {
    getItem(key) {
      const storage = load();
      return Object.hasOwn(storage, key) ? storage[key] : null;
    },
    setItem(key, value) {
      const storage = load();
      const oldValue = Object.hasOwn(storage, key) ? storage[key] : null;
      commit({ ...storage, [key]: value });
      return oldValue;
    },
    removeItem(key) {
      const storage = load();
      const oldValue = Object.hasOwn(storage, key) ? storage[key] : null;
      if (oldValue === null) return null;
      const next = { ...storage };
      delete next[key];
      commit(next);
      return oldValue;
    },
    migrate(entries) {
      const storage = load();
      const acceptsSensitiveEntries = !hasNativeAuthority;
      const changes = Object.entries(entries)
        .filter(
          ([key]) =>
            !Object.hasOwn(storage, key) &&
            (acceptsSensitiveEntries || !SENSITIVE_MIGRATION_KEYS.has(key)),
        )
        .map(([key, newValue]) => ({ key, oldValue: null, newValue }));
      if (changes.length === 0 && hasNativeAuthority) return changes;
      commit({
        ...storage,
        ...Object.fromEntries(changes.map(({ key, newValue }) => [key, newValue])),
      });
      return changes;
    },
    update(entries) {
      const storage = load();
      const next = { ...storage };
      const changes = [];
      for (const [key, newValue] of Object.entries(entries)) {
        const oldValue = Object.hasOwn(storage, key) ? storage[key] : null;
        if (oldValue === newValue) continue;
        if (newValue === null) delete next[key];
        else next[key] = newValue;
        changes.push({ key, oldValue, newValue });
      }
      if (changes.length === 0) return changes;
      commit(next);
      return changes;
    },
  };
}
