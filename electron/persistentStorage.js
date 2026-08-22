import fs from 'node:fs';
import path from 'node:path';

export function createPersistentStorage(filePath) {
  let cache = null;
  let temporaryFileSequence = 0;

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cache = Object.fromEntries(
          Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
        );
        return cache;
      }
    } catch {}
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
  };
}
