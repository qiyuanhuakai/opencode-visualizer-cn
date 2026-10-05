import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const input = JSON.parse(readFileSync(new URL('./seed090.json', import.meta.url), 'utf8'));
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// This oracle uses generation inputs only; it never reads generated rows or their manifest.
export function expectedInventory(count) {
  if (!input.profiles.includes(count)) throw new RangeError('count must be 10000 or 100000');
  const identities = createHash('sha256');
  const groups = { globalRoots: 0, codexThreads: 0, archived: 0, orphan: 0, child: 0, equalTimestamp: count };
  const sources = Object.fromEntries(input.sources.map((source) => [source, count / 5]));
  for (let ordinal = 0; ordinal < count; ordinal++) {
    identities.update(`${input.sources[ordinal % 5]}:native-${Math.floor(ordinal / 5)}\n`);
    if (ordinal % 5 === 0 && ordinal % 17 !== 0) groups.globalRoots++;
    if (ordinal % 5 === 1) groups.codexThreads++;
    if (ordinal % 23 === 0) groups.archived++;
    if (ordinal % 29 === 0) groups.orphan++;
    if (ordinal % 17 === 0) groups.child++;
  }
  return { seed: input.seed, sessions: count, drafts: count + 1, worktrees: 200, sources, groups,
    identitiesSha256: identities.digest('hex'), bodyBytes: count * input.bodyBytes + input.largeBodyBytes,
    attachmentBytes: count / input.attachmentEvery * input.attachmentBytes + input.largeAttachmentBytes };
}

export function summaryAt(ordinal) {
  return { source: input.sources[ordinal % 5], nativeSessionId: `native-${Math.floor(ordinal / 5)}`,
    title: `seed090 session ${ordinal}`, workspace: ordinal % 29 === 0 ? null : `worktrees/wt-${ordinal % 200}`,
    global: ordinal % 5 === 0, archived: ordinal % 23 === 0,
    parentId: ordinal % 17 === 0 ? 'native-parent' : null, updatedAt: input.timestamp };
}

export function wireAt(summary) {
  const { nativeSessionId: id, title, workspace, updatedAt, parentId, archived } = summary;
  switch (summary.source) {
    case 'opencode': return { id, slug: id, projectID: 'seed090', version: '1', title, directory: workspace ?? '', parentID: parentId ?? undefined, time: { created: updatedAt, updated: updatedAt, archived: archived ? updatedAt : undefined } };
    case 'codex': return { id, name: title, cwd: workspace ?? '', createdAt: updatedAt / 1000, updatedAt: updatedAt / 1000, archived, source: parentId ? { subAgent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } } : 'cli' };
    case 'acp': return { sessionId: id, title, cwd: workspace ?? '', updatedAt: new Date(updatedAt).toISOString(), _meta: { archived, parentId } };
    case 'kimi-web': return { id, workspace_id: workspace ?? 'orphan', title, created_at: new Date(updatedAt).toISOString(), updated_at: new Date(updatedAt).toISOString(), busy: false, main_turn_active: false, pending_interaction: 'none', archived, metadata: { cwd: workspace ?? '', parent_session_id: parentId ?? undefined } };
    case 'dsh': return { sessionId: id, workspaceId: workspace ?? undefined, title, cwd: workspace ?? '', createdAt: updatedAt, updatedAt, origin: parentId ? 'subagent' : undefined, parentSessionId: parentId ?? undefined, busy: false };
    default: throw new RangeError(`unknown source ${summary.source}`);
  }
}
