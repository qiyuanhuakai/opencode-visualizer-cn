import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell } from 'electron';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cleanupAsyncQuitOwners, installAsyncQuitCleanup } from './asyncQuitCleanup.js';
import { createDesktopRuntime } from './desktopRuntime.js';
import {
  clearApprovedLocalApplication,
  loadApprovedLocalApplication,
  persistApprovedLocalApplication,
} from './localApplicationApproval.js';
import { createLocalFileEditor } from './localFileEditor.js';
import { closeOwnedLocalFileSession } from './localFileSessionOwnership.js';
import { createPersistentStorage } from './persistentStorage.js';
import { registerPersistentStorageIpc } from './persistentStorageIpc.js';
import {
  classifyMime,
  classifyNavigation,
  classifyWindowOpen,
  isPermissionAllowed,
  isTrustedSender,
  resolveAppRelativePath,
} from './runtimePolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const PERSISTENT_STORAGE_FILE = 'renderer-storage.json';
const LOCAL_APPLICATION_APPROVAL_FILE = 'local-application.json';
const DEV_SERVER_URL = 'http://127.0.0.1:5173';
const LOCAL_APPLICATION_PATH_KEY = 'opencode.settings.localApplicationPath.v1';
const OPEN_IN_EDITOR_MAX_SIZE_KEY = 'opencode.settings.openInEditorMaxSizeMb.v1';
const RENDERER_STORAGE_PREFIX = 'opencode.';
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
let desktopRuntime = null;
let persistentStorage = null;
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
  onClosed: (sessionId) => {
    localFileSessionOwners.delete(sessionId);
  },
});

function persistentStorageFilePath() {
  return path.join(app.getPath('userData'), PERSISTENT_STORAGE_FILE);
}

function localApplicationApprovalFilePath() {
  return path.join(app.getPath('userData'), LOCAL_APPLICATION_APPROVAL_FILE);
}

function getPersistentStorage() {
  persistentStorage ??= createPersistentStorage(persistentStorageFilePath());
  return persistentStorage;
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
  if (
    !isTrustedSender({
      senderId: event.sender.id,
      mainWebContentsId: mainWindow ? mainWindow.webContents.id : null,
      mainWebContentsDestroyed: mainWindow ? mainWindow.webContents.isDestroyed() : true,
    })
  ) {
    throw new Error('Untrusted renderer');
  }
}

function configuredMaxLocalFileBytes() {
  const raw = getPersistentStorage().getItem(OPEN_IN_EDITOR_MAX_SIZE_KEY);
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

  desktopRuntime?.attachWindow(mainWindow);
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

  const appUrl = isDev ? DEV_SERVER_URL : 'app://index.html';

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
    const decision = classifyNavigation(navigationUrl, appUrl);
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'open-external') {
      shell.openExternal(navigationUrl);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (classifyWindowOpen(url) === 'open-external') {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    desktopRuntime?.restore();
  });

  app.whenReady().then(async () => {
    try {
      await getPersistentStorage().prepare();
    } catch (error) {
      console.error('[electron] Failed to prepare persistent storage; original data retained:', error);
    }
    approvedLocalApplicationPath = loadApprovedLocalApplication(localApplicationApprovalFilePath());
    desktopRuntime = createDesktopRuntime({
      getWindow: () => mainWindow,
      assertTrustedRenderer,
      closeLocalFiles: () => localFileEditor.closeAll(),
    });

    protocol.handle('app', async (request) => {
      const { pathname } = new URL(request.url);
      const relativePath = resolveAppRelativePath(pathname);
      if (relativePath === null) {
        return new Response('Not Found', { status: 404 });
      }
      // Support both unpacked (dev/preview) and asar-packed (production) layouts
      const roots = [
        path.join(__dirname, '..', 'dist'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'dist'),
      ];
      for (const root of roots) {
        const filePath = path.join(root, relativePath);
        // Final containment check: the resolved path must stay beneath the
        // resolved dist root (defense-in-depth behind resolveAppRelativePath).
        const resolvedRoot = path.resolve(root);
        const resolvedPath = path.resolve(filePath);
        if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + path.sep)) {
          continue;
        }
        try {
          const data = await fs.promises.readFile(filePath);
          return new Response(data, {
            headers: { 'Content-Type': classifyMime(relativePath) },
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
      } else {
        desktopRuntime?.restore();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

installAsyncQuitCleanup(
  app,
  async () => {
    const failures = [];
    try {
      await cleanupAsyncQuitOwners(localFileEditor, desktopRuntime);
    } catch (error) {
      failures.push(error);
    }
    try {
      await persistentStorage?.flush();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Desktop shutdown failed');
  },
  (error) => {
    console.error('[electron] Failed to clean desktop resources before quit:', error);
  },
);

app.on('web-contents-created', (_event, contents) => {
  contents.once('destroyed', () => {
    void closeLocalFileSessionsForOwner(contents.id).catch((error) => {
      console.error('[electron] Failed to clean renderer local edit sessions:', error);
    });
  });
  contents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isPermissionAllowed(permission));
  });
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});

ipcMain.handle('clipboard-write-text', (event, text) => {
  assertTrustedRenderer(event);
  if (typeof text !== 'string') {
    throw new Error('Invalid text: expected string');
  }
  clipboard.writeText(text);
});

ipcMain.handle('clipboard-read-text', (event) => {
  assertTrustedRenderer(event);
  return clipboard.readText();
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
  const oldValue = approvedLocalApplicationPath;
  persistApprovedLocalApplication(localApplicationApprovalFilePath(), selectedPath);
  approvedLocalApplicationPath = selectedPath;
  broadcastPersistentStorageChange(
    { key: LOCAL_APPLICATION_PATH_KEY, oldValue, newValue: selectedPath },
    event.sender.id,
  );
  return selectedPath;
});

ipcMain.handle('local-file-clear-application', (event) => {
  assertTrustedRenderer(event);
  const oldValue = approvedLocalApplicationPath;
  clearApprovedLocalApplication(localApplicationApprovalFilePath());
  approvedLocalApplicationPath = null;
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
  if (
    typeof approvedLocalApplicationPath !== 'string' ||
    approvedLocalApplicationPath.length === 0
  ) {
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
  await closeOwnedLocalFileSession(
    localFileSessionOwners,
    localFileEditor,
    event.sender.id,
    sessionId,
  );
});

registerPersistentStorageIpc({
  ipcMain,
  assertTrustedRenderer,
  getStorage: getPersistentStorage,
  broadcastChange: broadcastPersistentStorageChange,
  getLocalApplicationPath: () => approvedLocalApplicationPath,
  localApplicationPathKey: LOCAL_APPLICATION_PATH_KEY,
  rendererStoragePrefix: RENDERER_STORAGE_PREFIX,
});
