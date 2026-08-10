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
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

async function readUtf8Bounded(localPath, maxContentBytes) {
  const handle = await fs.promises.open(localPath, 'r');
  const chunks = [];
  let totalBytes = 0;
  const chunkSize = Math.min(64 * 1024, maxContentBytes + 1);
  try {
    while (totalBytes <= maxContentBytes) {
      const remaining = maxContentBytes + 1 - totalBytes;
      const buffer = Buffer.allocUnsafe(Math.min(chunkSize, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxContentBytes) return null;
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export function createLocalFileEditor(options) {
  const onChange = options?.onChange;
  if (typeof onChange !== 'function') throw new Error('onChange must be a function');
  const onError = typeof options?.onError === 'function' ? options.onError : () => {};
  const onClosed = typeof options?.onClosed === 'function' ? options.onClosed : () => {};
  const launch = options?.launchApplication ?? launchApplication;
  const watchDelayMs = options.watchDelayMs ?? 120;
  const sessions = new Map();
  const pendingOpens = new Map();
  const closingSessions = new Set();

  function reportError(error) {
    try {
      onError(error);
    } catch (reportFailure) {
      console.error('[electron] Failed to report local file error:', reportFailure);
    }
  }

  function closeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return Promise.resolve();
    session.terminal = true;
    if (session.closePromise) return session.closePromise;
    const cleanup = (async () => {
      if (session.watcher && !session.watcherClosed) {
        session.watcher.close();
        session.watcherClosed = true;
      }
      if (session.debounceTimer) {
        clearTimeout(session.debounceTimer);
        session.debounceTimer = null;
      }
      await session.readChain.catch(() => undefined);
      await fs.promises.rm(session.directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      try {
        onClosed(sessionId);
      } catch (error) {
        console.error('[electron] Failed to report local file closure:', error);
      }
    })();
    session.closePromise = cleanup.catch((error) => {
      session.closePromise = null;
      throw error;
    });
    return session.closePromise;
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

    const session = {
      directory,
      localPath,
      watcher: null,
      watcherClosed: false,
      terminal: false,
      closePromise: null,
      debounceTimer: null,
      readChain: Promise.resolve(),
    };
    sessions.set(sessionId, session);

    try {
      await fs.promises.writeFile(localPath, content, { encoding: 'utf8', mode: 0o600 });
      if (closingSessions.has(sessionId)) throw new Error('Local file session closed during opening');

      const readChange = async () => {
        try {
          const fileStat = await fs.promises.stat(localPath);
          if (fileStat.size > maxContentBytes) {
            reportError({
              sessionId,
              message: 'Local file content exceeds the configured size limit',
            });
            return;
          }
          const nextContent = await readUtf8Bounded(localPath, maxContentBytes);
          if (nextContent === null) {
            reportError({ sessionId, message: 'Local file content exceeds the configured size limit' });
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
      session.watcher.on('error', (error) => {
        session.terminal = true;
        reportError({
          sessionId,
          message: `Local file watcher failed: ${error.message}`,
          closed: true,
        });
        void closeSession(sessionId).catch((cleanupError) => {
          reportError({
            sessionId,
            message: `Local file watcher cleanup failed: ${cleanupError.message}`,
            closed: true,
          });
        });
      });
      if (closingSessions.has(sessionId) || session.terminal) {
        throw new Error('Local file session closed during opening');
      }

      await launch(applicationPath, localPath);
      if (closingSessions.has(sessionId) || session.terminal || !sessions.has(sessionId)) {
        throw new Error('Local file session closed during opening');
      }
    } catch (error) {
      try {
        await closeSession(sessionId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Failed to open and clean local file session');
      }
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
    try {
      const pending = pendingOpens.get(sessionId);
      if (pending) await pending.catch(() => undefined);
      await closeSession(sessionId);
    } finally {
      closingSessions.delete(sessionId);
    }
  }

  async function closeAll() {
    const sessionIds = new Set([...sessions.keys(), ...pendingOpens.keys()]);
    await Promise.all(Array.from(sessionIds, close));
  }

  return { open, close, closeAll };
}
