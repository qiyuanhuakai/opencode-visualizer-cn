import { createHash, createHmac } from 'node:crypto';

/**
 * OpenSSH `known_hosts` trust store. Parses the real file format (plain and hashed host
 * patterns, `@revoked` / `@cert-authority` markers, one entry per key type) and answers the one
 * question the transport must not get wrong: is this host key trusted, unknown (first trust), or
 * changed? A *changed* key is never silently accepted — the caller rejects it.
 *
 * Matching is bounded: lines and entry counts are capped, malformed lines are skipped rather than
 * thrown, and nothing here holds a secret.
 */
export const KNOWN_HOST_MARKERS = Object.freeze(['@cert-authority', '@revoked']);
const MAX_ENTRIES = 262_144;
const MAX_LINE_BYTES = 64 * 1024;

/** OpenSSH stores `host` for port 22 and `[host]:port` for any other port. */
export function hostPortKey(host, port = 22) {
  const normalized = String(host).toLowerCase();
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort === 22) return normalized;
  return `[${normalized}]:${numericPort}`;
}

/** `SHA256:<base64 without padding>` — the same display OpenSSH uses. */
export function keyFingerprint(keyBlob) {
  const raw = Buffer.from(String(keyBlob), 'base64');
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/u, '')}`;
}

function escapeRegExpCharacter(character) {
  return character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** OpenSSH host patterns support `*` and `?`; everything else is literal. */
function globMatches(pattern, hostPort) {
  let source = '^';
  for (const character of pattern.toLowerCase()) {
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else source += escapeRegExpCharacter(character);
  }
  return new RegExp(`${source}$`, 'u').test(hostPort);
}

function decodeHashedPattern(pattern) {
  const parts = pattern.split('|');
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== '1') return undefined;
  const salt = Buffer.from(parts[2], 'base64');
  if (salt.length === 0) return undefined;
  return { salt, hash: parts[3] };
}

function hashedPatternMatches(pattern, hostPort) {
  const decoded = decodeHashedPattern(pattern);
  if (decoded === undefined) return false;
  return createHmac('sha1', decoded.salt).update(hostPort).digest('base64') === decoded.hash;
}

function hostMatches(entry, hostPort) {
  let positive = false;
  for (const pattern of entry.patterns) {
    if (pattern.startsWith('!')) {
      const body = pattern.slice(1);
      if (body.startsWith('|') ? hashedPatternMatches(body, hostPort) : globMatches(body, hostPort)) return false;
    } else if (pattern.startsWith('|') ? hashedPatternMatches(pattern, hostPort) : globMatches(pattern, hostPort)) {
      positive = true;
    }
  }
  return positive;
}

export function parseKnownHosts(text) {
  if (typeof text !== 'string' || text.length === 0) return Object.freeze([]);
  const entries = [];
  for (const rawLine of text.split('\n')) {
    if (entries.length >= MAX_ENTRIES) break;
    if (rawLine.length > MAX_LINE_BYTES) continue;
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/u);
    let index = 0;
    const markers = [];
    while (index < tokens.length && KNOWN_HOST_MARKERS.includes(tokens[index])) {
      markers.push(tokens[index]);
      index += 1;
    }
    const patternField = tokens[index];
    const keyType = tokens[index + 1];
    const keyBlob = tokens[index + 2];
    if (patternField === undefined || keyType === undefined || keyBlob === undefined) continue;
    const patterns = patternField.split(',').filter((pattern) => pattern.length > 0);
    if (patterns.length === 0) continue;
    entries.push(Object.freeze({
      markers: Object.freeze(markers),
      patterns: Object.freeze(patterns),
      keyType,
      keyBlob,
      comment: tokens.slice(index + 3).join(' '),
    }));
  }
  return Object.freeze(entries);
}

/**
 * Trust verdict for one presented key. `changed` means the host is known but the key for that
 * key type differs — the transport must refuse the connection. A host only known with a
 * different key type is `unknown` (a first trust for this type), matching OpenSSH.
 */
export function evaluateHostKey(entries, { host, port = 22, keyType, keyBlob }) {
  const hostPort = hostPortKey(host, port);
  const fingerprint = keyFingerprint(keyBlob);
  const matching = entries.filter((entry) => hostMatches(entry, hostPort));
  if (matching.some((entry) => entry.markers.includes('@revoked') && entry.keyType === keyType)) {
    return Object.freeze({ status: 'revoked', fingerprint });
  }
  const trusted = matching.find((entry) => entry.keyType === keyType && entry.keyBlob === keyBlob);
  if (trusted !== undefined) return Object.freeze({ status: 'trusted', fingerprint, entry: trusted });
  if (matching.some((entry) => entry.keyType === keyType && entry.keyBlob !== keyBlob)) {
    return Object.freeze({ status: 'changed', fingerprint });
  }
  return Object.freeze({ status: 'unknown', fingerprint });
}

export function formatKnownHostEntry({ host, port = 22, keyType, keyBlob, marker }) {
  const prefix = KNOWN_HOST_MARKERS.includes(marker) ? `${marker} ` : '';
  return `${prefix}${hostPortKey(host, port)} ${keyType} ${keyBlob}\n`;
}

/** Appends a first-trust line, preserving the existing file without rewriting its entries. */
export function appendKnownHost(text, entry) {
  const base = typeof text === 'string' ? text : '';
  const separator = base.length === 0 || base.endsWith('\n') ? '' : '\n';
  return `${base}${separator}${formatKnownHostEntry(entry)}`;
}
