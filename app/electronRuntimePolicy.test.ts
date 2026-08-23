import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyMime,
  classifyNavigation,
  classifyWindowOpen,
  isPermissionAllowed,
  isTrustedSender,
  resolveAppRelativePath,
} from '../electron/runtimePolicy.js';

const mainSource = readFileSync(path.resolve(__dirname, '../electron/main.js'), 'utf8');

describe('electron-runtime-policy', () => {
  describe('resolveAppRelativePath', () => {
    it('maps the root path to index.html', () => {
      expect(resolveAppRelativePath('/')).toBe('index.html');
    });

    it('maps an empty pathname to index.html', () => {
      expect(resolveAppRelativePath('')).toBe('index.html');
    });

    it('keeps nested asset paths inside the app root', () => {
      expect(resolveAppRelativePath('/assets/app.js')).toBe('assets/app.js');
      expect(resolveAppRelativePath('/assets/css/style.css')).toBe('assets/css/style.css');
    });

    it('collapses dot segments without escaping the root', () => {
      expect(resolveAppRelativePath('/assets/./app.js')).toBe('assets/app.js');
      expect(resolveAppRelativePath('/assets/..')).toBe('index.html');
    });

    it('rejects any path that escapes above the app root', () => {
      expect(resolveAppRelativePath('/../../etc/passwd')).toBeNull();
      expect(resolveAppRelativePath('/assets/../../secret.txt')).toBeNull();
      expect(resolveAppRelativePath('/..')).toBeNull();
      expect(resolveAppRelativePath('/a/b/../../../x')).toBeNull();
    });

    it('rejects backslash traversal that escapes Windows-native path joins', () => {
      expect(resolveAppRelativePath('/assets\\..\\..\\outside.txt')).toBeNull();
      expect(resolveAppRelativePath('/assets\\..\\secret.txt')).toBeNull();
      expect(resolveAppRelativePath('\\..\\outside.txt')).toBeNull();
      expect(resolveAppRelativePath('/assets\\sub\\app.js')).toBeNull();
    });

    it('rejects mixed forward/backslash separator traversal', () => {
      expect(resolveAppRelativePath('/assets\\/../outside.txt')).toBeNull();
      expect(resolveAppRelativePath('/assets/..\\..\\outside.txt')).toBeNull();
      expect(resolveAppRelativePath('/assets\\..\\/outside.txt')).toBeNull();
    });

    it('rejects percent-encoded separators and dot segments', () => {
      expect(resolveAppRelativePath('/assets%5c..%5c..%5coutside.txt')).toBeNull();
      expect(resolveAppRelativePath('/assets%5C..%5Csecret.txt')).toBeNull();
      expect(resolveAppRelativePath('/%2e%2e/%2e%2e/outside.txt')).toBeNull();
      expect(resolveAppRelativePath('/assets/%2e%2e%5csecret.txt')).toBeNull();
      expect(resolveAppRelativePath('/assets%2f..%2fsecret.txt')).toBeNull();
    });

    it('rejects malformed percent-encoding instead of passing it through', () => {
      expect(resolveAppRelativePath('/assets/%zz/app.js')).toBeNull();
      expect(resolveAppRelativePath('/assets/%e0%a4%a')).toBeNull();
    });

    it('rejects trailing-dot and dot-space segments Windows folds into dot segments', () => {
      expect(resolveAppRelativePath('/assets/.../outside.txt')).toBeNull();
      expect(resolveAppRelativePath('/assets/.. /../outside.txt')).toBeNull();
      expect(resolveAppRelativePath('/assets/..%20/../outside.txt')).toBeNull();
    });

    it('never returns a path with backslashes or surviving dot-dot segments', () => {
      const inputs = [
        '/',
        '',
        '/assets/app.js',
        '/assets/../app.js',
        '/a/./b/c.css',
        '/assets\\..\\x',
        '/%2e%2e/x',
        '/assets/.../x',
      ];
      for (const input of inputs) {
        const result = resolveAppRelativePath(input);
        if (result === null) continue;
        expect(result).not.toContain('\\');
        expect(result.split('/')).not.toContain('..');
      }
    });
  });

  describe('classifyMime', () => {
    it('maps known extensions to their exact content type', () => {
      expect(classifyMime('index.html')).toBe('text/html');
      expect(classifyMime('assets/app.js')).toBe('application/javascript');
      expect(classifyMime('assets/style.css')).toBe('text/css');
      expect(classifyMime('manifest.json')).toBe('application/json');
      expect(classifyMime('assets/icon.svg')).toBe('image/svg+xml');
      expect(classifyMime('assets/font.woff2')).toBe('font/woff2');
    });

    it('never widens unknown extensions beyond octet-stream', () => {
      expect(classifyMime('assets/app.wasm')).toBe('application/octet-stream');
      expect(classifyMime('assets/binary.exe')).toBe('application/octet-stream');
      expect(classifyMime('assets/data.bin')).toBe('application/octet-stream');
      expect(classifyMime('noextension')).toBe('application/octet-stream');
    });
  });

  describe('classifyNavigation', () => {
    const appUrl = 'app://index.html';

    it('allows an exact match of the trusted app url', () => {
      expect(classifyNavigation(appUrl, appUrl)).toBe('allow');
    });

    it('rejects other app scheme urls', () => {
      expect(classifyNavigation('app://index.html/other', appUrl)).toBe('deny');
      expect(classifyNavigation('app://other.html', appUrl)).toBe('deny');
      expect(classifyNavigation('APP://index.html', appUrl)).toBe('deny');
    });

    it('routes http(s) navigation to the external browser', () => {
      expect(classifyNavigation('https://example.com/page', appUrl)).toBe('open-external');
      expect(classifyNavigation('http://127.0.0.1:5173', appUrl)).toBe('open-external');
    });

    it('denies javascript: file: data: and other non-http(s) schemes', () => {
      expect(classifyNavigation('javascript:alert(1)', appUrl)).toBe('deny');
      expect(classifyNavigation('file:///etc/passwd', appUrl)).toBe('deny');
      expect(classifyNavigation('data:text/html,<script>alert(1)</script>', appUrl)).toBe('deny');
      expect(classifyNavigation('chrome://settings', appUrl)).toBe('deny');
      expect(classifyNavigation('not a url', appUrl)).toBe('deny');
    });
  });

  describe('classifyWindowOpen', () => {
    it('opens http(s) popup urls in the external browser', () => {
      expect(classifyWindowOpen('https://example.com')).toBe('open-external');
      expect(classifyWindowOpen('http://localhost:3000')).toBe('open-external');
    });

    it('denies every non-http(s) popup url including app://', () => {
      expect(classifyWindowOpen('app://index.html')).toBe('deny');
      expect(classifyWindowOpen('javascript:alert(1)')).toBe('deny');
      expect(classifyWindowOpen('file:///etc/passwd')).toBe('deny');
      expect(classifyWindowOpen('data:text/html,<script>alert(1)</script>')).toBe('deny');
      expect(classifyWindowOpen('not a url')).toBe('deny');
    });
  });

  describe('isPermissionAllowed', () => {
    it('allows only notifications', () => {
      expect(isPermissionAllowed('notifications')).toBe(true);
    });

    it('denies every other permission', () => {
      for (const permission of [
        'geolocation',
        'media',
        'clipboard-read',
        'clipboard-sanitized-write',
        'fullscreen',
        'pointerLock',
        'openExternal',
        'midi',
      ]) {
        expect(isPermissionAllowed(permission)).toBe(false);
      }
    });
  });

  describe('isTrustedSender', () => {
    it('accepts the main window webContents as sender', () => {
      expect(
        isTrustedSender({ senderId: 7, mainWebContentsId: 7, mainWebContentsDestroyed: false }),
      ).toBe(true);
    });

    it('rejects a sender from a different webContents', () => {
      expect(
        isTrustedSender({ senderId: 8, mainWebContentsId: 7, mainWebContentsDestroyed: false }),
      ).toBe(false);
    });

    it('rejects when the main webContents is destroyed', () => {
      expect(
        isTrustedSender({ senderId: 7, mainWebContentsId: 7, mainWebContentsDestroyed: true }),
      ).toBe(false);
    });

    it('rejects when no main window exists', () => {
      expect(
        isTrustedSender({ senderId: 7, mainWebContentsId: null, mainWebContentsDestroyed: false }),
      ).toBe(false);
    });

    it('guards clipboard reads with the trusted renderer assertion', () => {
      // Given: clipboard read crosses from the sandboxed renderer into Electron main.
      const handler = mainSource.match(
        /ipcMain\.handle\('clipboard-read-text',[\s\S]*?\n\}\);/u,
      )?.[0];

      // When: the main-process IPC wiring is inspected.
      expect(handler).toBeDefined();

      // Then: sender validation runs before the native clipboard is read.
      expect(handler?.indexOf('assertTrustedRenderer(event)')).toBeGreaterThanOrEqual(0);
      expect(handler?.indexOf('clipboard.readText()')).toBeGreaterThan(
        handler?.indexOf('assertTrustedRenderer(event)') ?? Number.MAX_SAFE_INTEGER,
      );
    });

    it('does not call removed storage helpers before creating the first window', () => {
      // Given: renderer persistence is owned by the createPersistentStorage module.
      expect(mainSource).toContain('createPersistentStorage(persistentStorageFilePath)');

      // When: Electron enters its app.whenReady startup path.
      const readyPath = mainSource.match(/app\.whenReady\(\)\.then\(\(\) => \{[\s\S]*?createWindow\(\);/u)?.[0];

      // Then: startup never references the removed eager-load helper before window creation.
      expect(readyPath).toBeDefined();
      expect(readyPath).not.toContain('loadPersistentStorage');
    });

    it('acquires a single-instance lock before creating process-local storage', () => {
      // Given: renderer storage caches a whole-file snapshot inside one Electron process.
      const lockIndex = mainSource.indexOf('app.requestSingleInstanceLock()');
      const storageIndex = mainSource.indexOf('createPersistentStorage(persistentStorageFilePath)');

      // When: main-process initialization ordering is inspected.
      expect(lockIndex).toBeGreaterThanOrEqual(0);

      // Then: only the lock owner can initialize storage and later launches focus its window.
      expect(lockIndex).toBeLessThan(storageIndex);
      expect(mainSource).toMatch(/app\.on\('second-instance',[\s\S]*?mainWindow\.focus\(\)/u);
    });

    it('converts persistent storage mutation exceptions into false IPC acknowledgements', () => {
      // Given: set and remove are synchronous IPC boundaries backed by fallible disk writes.
      const setHandler = mainSource.match(
        /ipcMain\.on\('persistent-storage-set',[\s\S]*?\n\}\);/u,
      )?.[0];
      const removeHandler = mainSource.match(
        /ipcMain\.on\('persistent-storage-remove',[\s\S]*?\n\}\);/u,
      )?.[0];

      // When: the main-process mutation handlers are inspected.
      expect(setHandler).toBeDefined();
      expect(removeHandler).toBeDefined();

      // Then: each catches persistence exceptions and returns an explicit rejection.
      expect(setHandler).toMatch(/try\s*\{[\s\S]*catch\s*\{[\s\S]*event\.returnValue = false/u);
      expect(removeHandler).toMatch(/try\s*\{[\s\S]*catch\s*\{[\s\S]*event\.returnValue = false/u);
    });
  });
});
