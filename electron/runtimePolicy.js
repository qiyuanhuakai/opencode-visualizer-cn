// Pure, Electron-free policy decisions extracted from electron/main.js.
// Values in, decisions out — no side effects, no Electron imports.

const MIME_TYPES = Object.freeze({
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
});

const ALLOWED_PERMISSIONS = new Set(['notifications']);

/**
 * Resolve an `app://` URL pathname to a relative path inside the dist root.
 * Returns `null` when the path escapes above the root (deny: 404).
 * Both `''` and `'/'` (the two serializations of the app entry URL) map to
 * `index.html`.
 */
export function resolveAppRelativePath(pathname) {
  const segments = String(pathname ?? '').split('/');
  const stack = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.length === 0 ? 'index.html' : stack.join('/');
}

/** Classify an `app://` relative path by extension; unknown types never widen beyond octet-stream. */
export function classifyMime(relativePath) {
  const fileName = String(relativePath).split('/').pop() ?? '';
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function tryParseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Navigation decision for `will-navigate`: exact raw match of the trusted app
 * URL is allowed; http(s) is handed to the external browser; every other
 * scheme (javascript:, file:, data:, ...) is denied.
 */
export function classifyNavigation(navigationUrl, expectedAppUrl) {
  if (navigationUrl === expectedAppUrl) return 'allow';
  const parsed = tryParseUrl(navigationUrl);
  if (!parsed) return 'deny';
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return 'open-external';
  return 'deny';
}

/**
 * Window-open decision for `setWindowOpenHandler`: http(s) popups are handed
 * to the external browser; everything else (including `app://`) is denied.
 */
export function classifyWindowOpen(url) {
  const parsed = tryParseUrl(url);
  if (!parsed) return 'deny';
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return 'open-external';
  return 'deny';
}

/** Permission-request decision: only notifications are granted. */
export function isPermissionAllowed(permission) {
  return ALLOWED_PERMISSIONS.has(permission);
}

/**
 * IPC sender trust judgement: only the live main-window webContents is a
 * trusted renderer. `mainWebContentsId: null` means no main window exists.
 */
export function isTrustedSender({ senderId, mainWebContentsId, mainWebContentsDestroyed }) {
  if (mainWebContentsId === null || mainWebContentsId === undefined) return false;
  if (mainWebContentsDestroyed) return false;
  return senderId === mainWebContentsId;
}
