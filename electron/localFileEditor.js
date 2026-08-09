import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_CONTENT_BYTES = 20 * 1024 * 1024;

function launchApplication(applicationPath, localPath) {
  const launch =
    process.platform === 'darwin' && applicationPath.endsWith('.app')
      ? { command: '/usr/bin/open', args: ['-a', applicationPath, localPath] }
      : { command: applicationPath, args: [localPath] };
  return spawn(launch.command, launch.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
}

export function createLocalFileEditor(options) {
  const onChange = options?.onChange;
  if (typeof onChange !== 'function') throw new Error('onChange must be a function');
  const onError = typeof options?.onError === 'function' ? options.onError : () => {};
  const watchDelayMs = options.watchDelayMs ?? 120;
  const sessions = new Map();
  const pendingOpens = new Map();
  const closingSessions = new Set();

  async function closeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    session.watcher.close();
    if (session.debounceTimer) clearTimeout(session.debounceTimer);
    await session.readChain.catch(() => undefined);
    await fs.promises.rm(session.directory, { recursive: true, force: true });
  }

  async function openSession(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid local file payload');
    const { sessionId, applicationPath, fileName, content } = payload;
    const maxContentBytes =
      Number.isSafeInteger(payload.maxContentBytes) && payload.maxContentBytes > 0
        ? payload.maxContentBytes
        : DEFAULT_MAX_CONTENT_BYTES;
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
      throw new Error('Invalid local file session ID');
    }
    if (typeof applicationPath !== 'string' || !path.isAbsolute(applicationPath)) {
      throw new Error('Local application path must be absolute');
    }
    if (typeof fileName !== 'string' || typeof content !== 'string') {
      throw new Error('Invalid local file content');
    }
    if (Buffer.byteLength(content, 'utf8') > maxContentBytes) {
      throw new Error('Local file content exceeds the configured size limit');
    }
    await fs.promises.access(applicationPath, fs.constants.X_OK);
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vis-edit-'));
    const safeName = path.basename(fileName.trim()) || 'untitled.txt';
    const localPath = path.join(directory, safeName);
    await fs.promises.writeFile(localPath, content, { encoding: 'utf8', mode: 0o600 });

    const session = {
      directory,
      localPath,
      watcher: null,
      debounceTimer: null,
      readChain: Promise.resolve(),
    };

    const readChange = async () => {
      try {
        const nextContent = await fs.promises.readFile(localPath, 'utf8');
        if (Buffer.byteLength(nextContent, 'utf8') > maxContentBytes) {
          onError({ sessionId, message: 'Local file content exceeds the configured size limit' });
          return;
        }
        onChange({ sessionId, content: nextContent });
      } catch (error) {
        if (sessions.has(sessionId)) console.error('[electron] Failed to read local edit:', error);
      }
    };

    session.watcher = fs.watch(directory, { persistent: false }, (_eventType, changedName) => {
      if (changedName && changedName.toString() !== safeName) return;
      if (session.debounceTimer) clearTimeout(session.debounceTimer);
      session.debounceTimer = setTimeout(() => {
        session.debounceTimer = null;
        session.readChain = session.readChain.then(readChange, readChange);
      }, watchDelayMs);
    });
    sessions.set(sessionId, session);
    if (closingSessions.has(sessionId)) {
      await closeSession(sessionId);
      throw new Error('Local file session closed during opening');
    }

    try {
      const child = launchApplication(applicationPath, localPath);
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      if (closingSessions.has(sessionId) || !sessions.has(sessionId)) {
        throw new Error('Local file session closed during opening');
      }
    } catch (error) {
      await closeSession(sessionId);
      throw error;
    }

    return { sessionId, localPath };
  }

  function open(payload) {
    const sessionId = payload?.sessionId;
    if (
      typeof sessionId === 'string' &&
      (sessions.has(sessionId) || pendingOpens.has(sessionId))
    ) return Promise.reject(new Error('Local file session already exists'));

    const opening = openSession(payload);
    if (typeof sessionId === 'string') {
      pendingOpens.set(sessionId, opening);
      void opening.finally(() => pendingOpens.delete(sessionId)).catch(() => undefined);
    }
    return opening;
  }

  async function close(sessionId) {
    closingSessions.add(sessionId);
    await closeSession(sessionId);
    const pending = pendingOpens.get(sessionId);
    if (pending) await pending.catch(() => undefined);
    closingSessions.delete(sessionId);
  }

  async function closeAll() {
    const sessionIds = new Set([...sessions.keys(), ...pendingOpens.keys()]);
    await Promise.all(Array.from(sessionIds, close));
  }

  return { open, close, closeAll };
}
