import { describe, expect, it } from 'vitest';
import {
  classifyMime,
  classifyNavigation,
  classifyWindowOpen,
  isPermissionAllowed,
  isTrustedSender,
  resolveAppRelativePath,
} from '../electron/runtimePolicy.js';

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
  });
});
