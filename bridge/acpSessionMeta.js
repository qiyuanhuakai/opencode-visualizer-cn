import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Per-turn metadata recovered from an ACP agent's own session storage.
// ACP v1 replays carry no per-message timestamps/agent/model, so vis falls
// back to these files for sessions that predate the frontend's local
// attribution records. Shape returned to the frontend:
// { userText, userTime, assistantTime?, model?, agent? }

function parseJsonLines(content) {
  const rows = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Skip corrupt lines; storage files are append-only and may be torn.
    }
  }
  return rows;
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

const KIMI_PERMISSION_MODE_TO_AGENT = {
  manual: 'default',
  default: 'default',
  plan: 'plan',
  auto: 'auto',
  yolo: 'yolo',
};

export function parseKimiWireLog(content) {
  const rows = parseJsonLines(content);
  const turns = [];
  let permissionMode = 'default';
  let planMode = false;
  const agentAt = () => (planMode ? 'plan' : (KIMI_PERMISSION_MODE_TO_AGENT[permissionMode] ?? 'default'));
  for (const row of rows) {
    if (row.type === 'plan_mode.enter') {
      planMode = true;
      continue;
    }
    if (row.type === 'plan_mode.cancel') {
      planMode = false;
      continue;
    }
    if (row.type === 'permission.set_mode' && typeof row.mode === 'string') {
      permissionMode = row.mode;
      continue;
    }
    if (row.type === 'turn.prompt') {
      turns.push({
        userText: textFromBlocks(row.input),
        userTime: typeof row.time === 'number' ? row.time : undefined,
        assistantTime: undefined,
        assistantCompletedTime: undefined,
        model: undefined,
        agent: agentAt(),
      });
      continue;
    }
    if (row.type === 'usage.record' && row.usageScope === 'turn' && turns.length > 0) {
      const turn = turns[turns.length - 1];
      if (typeof row.time === 'number') {
        if (turn.assistantTime === undefined) turn.assistantTime = row.time;
        turn.assistantCompletedTime = row.time;
      }
      if (typeof row.model === 'string') turn.model = row.model;
    }
  }
  return turns;
}

export function parseOmpSessionLog(content) {
  const rows = parseJsonLines(content);
  const turns = [];
  for (const row of rows) {
    if (row.type !== 'message' || !row.message || typeof row.message !== 'object') continue;
    const message = row.message;
    if (message.role === 'user') {
      turns.push({
        userText: textFromBlocks(message.content),
        userTime: typeof message.timestamp === 'number' ? message.timestamp : undefined,
        assistantTime: undefined,
        assistantCompletedTime: undefined,
        model: undefined,
        agent: undefined,
      });
      continue;
    }
    if (message.role === 'assistant' && turns.length > 0) {
      const turn = turns[turns.length - 1];
      if (typeof message.timestamp === 'number') {
        turn.assistantTime = message.timestamp;
        turn.assistantCompletedTime =
          typeof message.duration === 'number'
            ? message.timestamp + message.duration
            : message.timestamp;
      }
      if (typeof message.provider === 'string' && typeof message.model === 'string') {
        turn.model = `${message.provider}/${message.model}`;
      }
    }
  }
  return turns;
}

async function findFileRecursive(rootDir, match, maxDepth) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && match(full)) {
        found.push(full);
      }
    }
  }
  await walk(rootDir, 0);
  return found;
}

async function newestFile(candidates) {
  let best;
  let bestMtime = -1;
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.mtimeMs > bestMtime) {
        bestMtime = info.mtimeMs;
        best = candidate;
      }
    } catch {
      // ignore vanished files
    }
  }
  return best;
}

// Locates and parses the agent's session storage for one session.
// Returns null when the agent/storage layout is unknown or the file is absent.
export async function loadAcpSessionTurnMeta(agentId, sessionId, options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  if (typeof sessionId !== 'string' || !sessionId || sessionId.includes('..')) return null;

  if (agentId === 'kimi-code') {
    const sessionsRoot = path.join(homeDir, '.kimi-code', 'sessions');
    const candidates = await findFileRecursive(
      sessionsRoot,
      (file) => file.endsWith(`${path.sep}agents${path.sep}main${path.sep}wire.jsonl`) && file.includes(`${path.sep}${sessionId}${path.sep}`),
      5,
    );
    const file = await newestFile(candidates);
    if (!file) return null;
    return parseKimiWireLog(await readFile(file, 'utf8'));
  }

  if (agentId === 'oh-my-pi') {
    const sessionsRoot = path.join(homeDir, '.omp', 'agent', 'sessions');
    const candidates = await findFileRecursive(
      sessionsRoot,
      (file) => file.endsWith('.jsonl') && path.basename(file).includes(sessionId),
      2,
    );
    const file = await newestFile(candidates);
    if (!file) return null;
    return parseOmpSessionLog(await readFile(file, 'utf8'));
  }

  return null;
}
