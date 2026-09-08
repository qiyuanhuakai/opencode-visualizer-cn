import path from 'node:path';

const MAX_ERROR_MESSAGE_LENGTH = 500;
const HTTP_URL_PATTERN = /https?:\/\/[^\s]+/giu;

export function transition(phase) {
  return { phase, progress: null, error: null };
}

export function versionFromInfo(info) {
  return info && typeof info.version === 'string' ? info.version : null;
}

export function assetNameFromInfo(info) {
  const url = info && Array.isArray(info.files) && info.files[0] && info.files[0].url;
  return typeof url === 'string' ? path.basename(url) : null;
}

export function boundedPercent(progress) {
  const percent = progress && typeof progress.percent === 'number' ? progress.percent : 0;
  return Math.max(0, Math.min(100, percent));
}

export function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(HTTP_URL_PATTERN, sanitizeUrl).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export function unsupportedMessage(component) {
  return component === 'app'
    ? 'App updates are unavailable in development or on this platform'
    : 'Bridge updates are unavailable on this platform or architecture';
}

export function initialState(component, currentVersion, installKind) {
  const unavailable = installKind === 'unsupported' || installKind === 'remote';
  return {
    component,
    currentVersion,
    availableVersion: null,
    phase: unavailable ? 'unsupported' : 'idle',
    progress: null,
    error: installKind === 'unsupported' ? unsupportedMessage(component) : null,
    installKind,
    assetName: null,
  };
}

export async function settleWithin(promise, timeoutMs) {
  let timeout;
  const bounded = new Promise((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([promise, bounded]);
  clearTimeout(timeout);
}

function sanitizeUrl(value) {
  const trailing = /[),.;!?]+$/u.exec(value)?.[0] ?? '';
  const candidate = trailing ? value.slice(0, -trailing.length) : value;
  try {
    const url = new URL(candidate);
    return `${url.protocol}//${url.host}${url.pathname}${trailing}`;
  } catch {
    return '[invalid URL]';
  }
}
