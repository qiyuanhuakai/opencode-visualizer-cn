// Task 26 registered QA browser entry — the browser-shaped surface of the SSH
// transport: a real Chromium proves that the secret-handling projections and the
// binary relay framing cannot leak or corrupt once they cross into a renderer.
//
// Loaded by scripts/qa/runtime-v090-cases/task-26.mjs from a runner-served page.
// The REAL landed code executes here:
//   * app/bridge/runtime/transports/sshAuthentication.js — createSecretBox,
//     redactSecrets, REDACTED, AUTH_CHALLENGE_KINDS, createSecretChannel;
//   * app/bridge/runtime/transports/processRelay.js — encodeRelayFrame,
//     decodeRelayFrames, RELAY_MAX_FRAME_BYTES.
// The only controlled boundary is scripts/qa/runtime-v090-cases/task-26-browser-shim.mjs,
// which backs the `node:*` specifiers (in-memory files, a synthetic uuid, throwing
// spawn/connect/hash) because a renderer has no OS primitives. The transport LOGIC is
// real; the OS edge is the fixture. This entry never spawns ssh and never claims a
// live SSH verification — task 46 owns that end-to-end check.
import { Buffer as NodeBuffer } from 'buffer';
import {
  AUTH_CHALLENGE_KINDS,
  REDACTED,
  createSecretBox,
  createSecretChannel,
  redactSecrets,
} from '../../../bridge/runtime/transports/sshAuthentication.js';
import { RELAY_MAX_FRAME_BYTES, decodeRelayFrames, encodeRelayFrame } from '../../../bridge/runtime/transports/processRelay.js';

type AnyRecord = Record<string, any>;

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

(globalThis as AnyRecord).Buffer = (globalThis as AnyRecord).Buffer ?? NodeBuffer;

// ── console spy: prove a secret never reaches any console channel from the renderer ──
const consoleEntries: Array<{ level: string; text: string }> = [];
function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { consoleEntries.push({ level, text: args.map(safeString).join(' ') }); } catch { /* capture never throws */ }
    original(...args);
  };
}
const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

const domHost = document.createElement('pre');
domHost.id = 'qa26-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

const occurrences = (haystack: string, needle: string): number => (needle.length === 0 ? 0 : haystack.split(needle).length - 1);

// ── BH1: secret boxes and redaction are leak-proof in every projection the renderer sees ──
function redaction(secret: string): AnyRecord {
  const box = createSecretBox(secret);
  const stringified = String(box);
  const json = JSON.stringify(box);
  const inspected = String((box as unknown as Record<symbol, (() => string) | undefined>)[INSPECT]?.() ?? '');
  const redactedText = redactSecrets(`ssh: auth failed for ${secret} (pass ${secret})`, [secret]);
  // The exact JSON a browser surface would render for an auth result.
  const projection = {
    argv: ['-T', '-o', 'RequestTTY=no', '-o', 'ForwardAgent=no'],
    auth: { methods: ['password'], secrets: [box], hostKeyFingerprint: 'SHA256:Q0F1...' },
    secret: box,
    redacted: redactedText,
    inspected,
  };
  domHost.textContent = JSON.stringify(projection);
  const domText = domHost.textContent ?? '';
  const consumed = box.consume();
  let secondConsume: string | null = null;
  try { box.consume(); } catch (error) { secondConsume = error instanceof Error ? `${(error as AnyRecord).code}/${(error as AnyRecord).field}` : String(error); }
  return {
    toString: stringified,
    toJSON: json,
    inspect: inspected,
    redactedText,
    redactedMarker: REDACTED,
    challengeKinds: [...AUTH_CHALLENGE_KINDS],
    consumeMatches: consumed === secret,
    secondConsume,
    domOccurrences: occurrences(domText, secret),
    domLength: domText.length,
  };
}

// ── BH2: the secret channel delivers a PATH (never a value) into the renderer env ──
async function secretChannel(secret: string, directory: string, askpassPath: string): Promise<AnyRecord> {
  const channel = await createSecretChannel([createSecretBox(secret)], { directory, askpassPath });
  const env = channel.env as Record<string, string>;
  const filePath = String(channel.filePath);
  let fileCleanedUp = false;
  await channel.cleanup();
  try { await (await import('node:fs/promises')).readFile(filePath); } catch { fileCleanedUp = true; }
  return {
    askpass: env.SSH_ASKPASS,
    askpassRequire: env.SSH_ASKPASS_REQUIRE,
    filePathIsPath: !filePath.includes(secret),
    filePathStem: filePath.split('/').pop()?.replace(/[0-9a-f-]{36}$/u, '<uuid>') ?? null,
    secretInEnv: JSON.stringify(env).includes(secret),
    envKeys: Object.keys(env).sort(),
    fileCleanedUp,
  };
}

// ── BH3: length-prefixed relay framing survives binary payloads and rejects oversize ──
function framing(bytes: number[]): AnyRecord {
  const payload = Buffer.from(bytes);
  const frame = encodeRelayFrame(payload);
  const pieces = [frame.subarray(0, 1), frame.subarray(1, 3), frame.subarray(3)];
  let remaining: Buffer = Buffer.alloc(0);
  const frames: number[][] = [];
  for (const piece of pieces) {
    const decoded = decodeRelayFrames(Buffer.concat([remaining, piece]));
    remaining = decoded.remaining;
    for (const entry of decoded.frames) frames.push(Array.from(entry));
  }
  let oversized: string | null = null;
  try { encodeRelayFrame(Buffer.alloc(RELAY_MAX_FRAME_BYTES + 1)); }
  catch (error) { oversized = error instanceof Error ? error.message : String(error); }
  return {
    frames,
    frameCount: frames.length,
    remainingLength: remaining.length,
    frameLength: frame.length,
    payloadLength: payload.length,
    maxFrameBytes: RELAY_MAX_FRAME_BYTES,
    oversized,
  };
}

const api = {
  ready: true,
  errors: () => errors,
  consoleEntries: () => consoleEntries,
  domText: () => domHost.textContent ?? '',
  redaction,
  secretChannel,
  framing,
};

(window as unknown as AnyRecord).task26 = api;
