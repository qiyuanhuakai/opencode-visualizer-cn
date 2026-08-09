import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell } from 'electron';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createLocalFileEditor } from './localFileEditor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const PERSISTENT_STORAGE_FILE = 'renderer-storage.json';
const LOCAL_APPLICATION_APPROVAL_FILE = 'local-application.json';
const DEV_SERVER_URL = 'http://127.0.0.1:5173';
const LOCAL_APPLICATION_PATH_KEY = 'opencode.settings.localApplicationPath.v1';
const OPEN_IN_EDITOR_MAX_SIZE_KEY = 'opencode.settings.openInEditorMaxSizeMb.v1';
const DEFAULT_MAX_LOCAL_FILE_BYTES = 20 * 1024 * 1024;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow = null;
let persistentStorageCache = null;
let approvedLocalApplicationPath = null;
const localFileSessionOwners = new Map();
const localFileEditor = createLocalFileEditor({
  onChange(change) {
    const ownerId = localFileSessionOwners.get(change.sessionId);
    if (typeof ownerId !== 'number') return;
    const ownerWindow = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.id === ownerId && !window.webContents.isDestroyed(),
    );
    ownerWindow?.webContents.send('local-file-changed', change);
  },
  onError(error) {
    const ownerId = localFileSessionOwners.get(error.sessionId);
    if (typeof ownerId !== 'number') return;
    const ownerWindow = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.id === ownerId && !window.webContents.isDestroyed(),
    );
    ownerWindow?.webContents.send('local-file-error', error);
  },
});

function persistentStorageFilePath() {
  return path.join(app.getPath('userData'), PERSISTENT_STORAGE_FILE);
}

function localApplicationApprovalFilePath() {
  return path.join(app.getPath('userData'), LOCAL_APPLICATION_APPROVAL_FILE);
}

function loadApprovedLocalApplicationPath() {
  try {
    const parsed = JSON.parse(fs.readFileSync(localApplicationApprovalFilePath(), 'utf8'));
    return typeof parsed?.path === 'string' && path.isAbsolute(parsed.path) ? parsed.path : null;
  } catch {
    return null;
  }
}

function persistApprovedLocalApplicationPath(applicationPath) {
  const filePath = localApplicationApprovalFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ path: applicationPath }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function loadPersistentStorage() {
  if (persistentStorageCache) {
    return persistentStorageCache;
  }

  try {
    const raw = fs.readFileSync(persistentStorageFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      persistentStorageCache = Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
      );
      return persistentStorageCache;
    }
  } catch {
    // Ignore missing or malformed storage files and recreate them on write.
  }

  persistentStorageCache = {};
  return persistentStorageCache;
}

function writePersistentStorage() {
  const filePath = persistentStorageFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(loadPersistentStorage(), null, 2), 'utf8');
}

function getPersistentStorageItem(key) {
  const storage = loadPersistentStorage();
  return Object.hasOwn(storage, key) ? storage[key] : null;
}

function setPersistentStorageItem(key, value) {
  const storage = loadPersistentStorage();
  const oldValue = Object.hasOwn(storage, key) ? storage[key] : null;
  storage[key] = value;
  writePersistentStorage();
  return oldValue;
}

function removePersistentStorageItem(key) {
  const storage = loadPersistentStorage();
  const oldValue = Object.hasOwn(storage, key) ? storage[key] : null;
  if (oldValue === null) {
    return null;
  }
  delete storage[key];
  writePersistentStorage();
  return oldValue;
}

function broadcastPersistentStorageChange(change, sourceWebContentsId) {
  for (const window of BrowserWindow.getAllWindows()) {
    const { webContents } = window;
    if (webContents.isDestroyed() || webContents.id === sourceWebContentsId) {
      continue;
    }
    webContents.send('persistent-storage-changed', change);
  }
}

function assertTrustedRenderer(event) {
  if (!mainWindow || mainWindow.webContents.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('Untrusted renderer');
  }
}

function configuredMaxLocalFileBytes() {
  const raw = getPersistentStorageItem(OPEN_IN_EDITOR_MAX_SIZE_KEY);
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return DEFAULT_MAX_LOCAL_FILE_BYTES;
  return Math.min(Math.round(megabytes), 100) * 1024 * 1024;
}

async function closeLocalFileSessionsForOwner(ownerId) {
  const sessionIds = Array.from(localFileSessionOwners.entries())
    .filter(([, candidateOwnerId]) => candidateOwnerId === ownerId)
    .map(([sessionId]) => sessionId);
  for (const sessionId of sessionIds) localFileSessionOwners.delete(sessionId);
  await Promise.all(sessionIds.map((sessionId) => localFileEditor.close(sessionId)));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
    backgroundColor: '#1a1a2e',
  });

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL('app://index.html');
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    const hasCors = Object.keys(responseHeaders).some(
      (k) => k.toLowerCase() === 'access-control-allow-origin',
    );
    if (!hasCors) {
      responseHeaders['Access-Control-Allow-Origin'] = ['*'];
    }
    callback({ responseHeaders });
  });

  const appUrl = isDev
    ? DEV_SERVER_URL
    : 'app://index.html';

  if (isDev) {
    mainWindow.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL) => {
        console.error(
          `[electron] Failed to load ${validatedURL} (${errorCode}): ${errorDescription}`,
        );
      },
    );
  }

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== appUrl) {
      event.preventDefault();
      try {
        const parsed = new URL(navigationUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          shell.openExternal(navigationUrl);
        }
      } catch {
        return;
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  loadPersistentStorage();
  approvedLocalApplicationPath = loadApprovedLocalApplicationPath();

  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const relativePath = pathname === '/' ? 'index.html' : pathname;
    // Support both unpacked (dev/preview) and asar-packed (production) layouts
    const candidates = [
      path.join(__dirname, '..', 'dist', relativePath),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', relativePath),
    ];
    for (const filePath of candidates) {
      try {
        const data = await fs.promises.readFile(filePath);
        const ext = path.extname(relativePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf',
          '.otf': 'font/otf',
        };
        return new Response(data, {
          headers: { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' },
        });
      } catch {
        // try next candidate
      }
    }
    return new Response('Not Found', { status: 404 });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  void localFileEditor.closeAll().catch((error) => {
    console.error('[electron] Failed to clean local edit sessions:', error);
  });
});

app.on('web-contents-created', (_event, contents) => {
  contents.once('destroyed', () => {
    void closeLocalFileSessionsForOwner(contents.id).catch((error) => {
      console.error('[electron] Failed to clean renderer local edit sessions:', error);
    });
  });
  contents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowedPermissions = new Set(['notifications']);
      callback(allowedPermissions.has(permission));
    }
  );
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});

ipcMain.handle('clipboard-write-text', (_event, text) => {
  if (typeof text !== 'string') {
    throw new Error('Invalid text: expected string');
  }
  clipboard.writeText(text);
});

ipcMain.handle('local-file-select-application', async (event) => {
  assertTrustedRenderer(event);
  const options = {
    title: 'Select application',
    properties: ['openFile'],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  const selectedPath = result.canceled ? null : (result.filePaths[0] ?? null);
  if (!selectedPath) return null;
  await fs.promises.access(selectedPath, fs.constants.X_OK);
  approvedLocalApplicationPath = selectedPath;
  persistApprovedLocalApplicationPath(selectedPath);
  const oldValue = setPersistentStorageItem(LOCAL_APPLICATION_PATH_KEY, selectedPath);
  broadcastPersistentStorageChange(
    { key: LOCAL_APPLICATION_PATH_KEY, oldValue, newValue: selectedPath },
    event.sender.id,
  );
  return selectedPath;
});

ipcMain.handle('local-file-clear-application', (event) => {
  assertTrustedRenderer(event);
  approvedLocalApplicationPath = null;
  try {
    fs.rmSync(localApplicationApprovalFilePath(), { force: true });
  } catch (error) {
    console.error('[electron] Failed to clear local application approval:', error);
  }
  const oldValue = removePersistentStorageItem(LOCAL_APPLICATION_PATH_KEY);
  if (oldValue !== null) {
    broadcastPersistentStorageChange(
      { key: LOCAL_APPLICATION_PATH_KEY, oldValue, newValue: null },
      event.sender.id,
    );
  }
});

ipcMain.handle('local-file-open', async (event, payload) => {
  assertTrustedRenderer(event);
  const sessionId = payload?.sessionId;
  if (typeof sessionId !== 'string') throw new Error('Invalid local file session ID');
  if (typeof approvedLocalApplicationPath !== 'string' || approvedLocalApplicationPath.length === 0) {
    throw new Error('No local application has been approved');
  }
  localFileSessionOwners.set(sessionId, event.sender.id);
  try {
    const opened = await localFileEditor.open({
      sessionId,
      applicationPath: approvedLocalApplicationPath,
      fileName: payload?.fileName,
      content: payload?.content,
      maxContentBytes: configuredMaxLocalFileBytes(),
    });
    return { sessionId: opened.sessionId };
  } catch (error) {
    localFileSessionOwners.delete(sessionId);
    throw error;
  }
});

ipcMain.handle('local-file-close', async (event, sessionId) => {
  assertTrustedRenderer(event);
  if (typeof sessionId !== 'string') throw new Error('Invalid local file session ID');
  if (localFileSessionOwners.get(sessionId) !== event.sender.id) return;
  localFileSessionOwners.delete(sessionId);
  await localFileEditor.close(sessionId);
});

ipcMain.on('persistent-storage-get', (event, key) => {
  if (typeof key !== 'string') {
    event.returnValue = null;
    return;
  }
  event.returnValue = getPersistentStorageItem(key);
});

ipcMain.on('persistent-storage-set', (event, payload) => {
  const key = payload?.key;
  const value = payload?.value;
  if (typeof key !== 'string' || typeof value !== 'string') {
    event.returnValue = false;
    return;
  }

  const currentValue = getPersistentStorageItem(key);
  if (currentValue === value) {
    event.returnValue = true;
    return;
  }
  const oldValue = setPersistentStorageItem(key, value);
  broadcastPersistentStorageChange({ key, oldValue, newValue: value }, event.sender.id);
  event.returnValue = true;
});

ipcMain.on('persistent-storage-remove', (event, key) => {
  if (typeof key !== 'string') {
    event.returnValue = false;
    return;
  }

  const oldValue = removePersistentStorageItem(key);
  if (oldValue !== null) {
    broadcastPersistentStorageChange({ key, oldValue, newValue: null }, event.sender.id);
  }
  event.returnValue = true;
});
