import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const PERSISTENT_STORAGE_FILE = 'renderer-storage.json';
const DEV_SERVER_URL = 'http://127.0.0.1:5173';

let mainWindow = null;
let persistentStorageCache = null;

function persistentStorageFilePath() {
  return path.join(app.getPath('userData'), PERSISTENT_STORAGE_FILE);
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
    console.log(`[electron] Loading dev server at ${DEV_SERVER_URL}`);
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
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
    : path.join(__dirname, '../dist/index.html');

  if (isDev) {
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[electron] Renderer finished loading');
    });
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

app.on('web-contents-created', (_event, contents) => {
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
