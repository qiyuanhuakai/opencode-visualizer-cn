import path from 'node:path';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { requireValue } from '../../../shared/runtime/capabilities.js';
import { decodeRepoKey, encodeSessionKey } from '../../../shared/runtime/identity.js';
import { MAX_EVIDENCE_BYTES, parseCheckpoint, parseEvidenceOrigin, parseEvidenceRef, registerEvidence, verifyCurrentTarget } from '../../../shared/runtime/context.js';
import { resolveReadablePath } from '../../workspaceFs.js';
import { createGitRunner } from '../collaboration/writerLeases.js';
import { createEvidenceQuery } from './evidenceQuery.js';

export function createHostEvidence({ environmentId, threads, checkpoints, handoff, workspace, store, resolveDirectory }) {
  const records = new Map();
  const git = createGitRunner({ outputLimit: MAX_EVIDENCE_BYTES });
  const key = value => createHash('sha256').update(JSON.stringify([value.threadId, value.record.hash, value.record.target, value.record.origin])).digest('hex');
  async function context(threadId, participantId) {
    const thread = threads.get(threadId);
    requireValue(thread.environmentId === environmentId, 'host.evidence_scope', 'unauthorized');
    const participant = thread.participants.find(item => item.participantId === (participantId ?? thread.activeParticipantId));
    requireValue(participant, 'host.evidence_participant', 'source_unavailable');
    const session = await store.get({ collection: 'session_summaries', key: encodeSessionKey(participant.session) });
    const root = workspace.workspaces.find(item => item.key === session?.value?.workspaceKey);
    requireValue(root, 'host.evidence_workspace', 'unauthorized');
    const indexed = await store.get({ collection: 'workspaces', key: root.key });
    requireValue(indexed?.value?.repoKey === thread.repoKey, 'host.evidence_repository', 'unauthorized');
    const directory = await resolveDirectory(participant.session, session.value.directory, root);
    const head = await git({ cwd: directory, args: ['rev-parse', '--verify', 'HEAD'] });
    let revision = head.stdout.trim();
    if (head.exitCode !== 0) {
      const branch = await git({ cwd: directory, args: ['symbolic-ref', '--quiet', 'HEAD'] });
      requireValue(branch.exitCode === 0, 'host.evidence_head', 'source_unavailable');
      revision = `unborn:${branch.stdout.trim()}`;
    }
    const common = await git({ cwd: directory, args: ['rev-parse', '--git-common-dir'] });
    requireValue(common.exitCode === 0 && await realpath(path.resolve(directory, common.stdout.trim())) ===
      decodeRepoKey(thread.repoKey).canonicalCommonDir, 'host.evidence_repository', 'unauthorized');
    return { thread, root: directory, target: { repoKey: thread.repoKey, revision } };
  }
  function checkpoint(handoffId) {
    const record = handoff.handoff(handoffId);
    const value = parseCheckpoint(checkpoints.get(record.checkpoint.checkpointId));
    const thread = threads.get(record.threadId);
    requireValue(record.environmentId === environmentId && value.scope.environmentId === environmentId &&
      value.scope.threadId === thread.threadId, 'host.evidence_scope', 'unauthorized');
    requireValue(value.evidence.every(ref => ref.target.repoKey === thread.repoKey), 'host.evidence_repository', 'unauthorized');
    return value;
  }
  async function handoffContext(handoffId) {
    const record = handoff.handoff(handoffId);
    checkpoint(handoffId);
    return context(record.threadId, record.target.participantId);
  }
  async function bytes(root, origin, target) {
    requireValue(typeof origin.path === 'string' && origin.path.length > 0 && !path.isAbsolute(origin.path) &&
      !origin.path.split(/[\\/]/).includes('..'), 'host.evidence_path', 'unauthorized');
    const requested = path.resolve(root, origin.path);
    if (origin.kind === 'diff') {
      let base = target.revision;
      if (base.startsWith('unborn:')) {
        const empty = await git({ cwd: root, args: ['hash-object', '-t', 'tree', '--stdin'] });
        requireValue(empty.exitCode === 0, 'host.evidence_base', 'source_unavailable');
        base = empty.stdout.trim();
      }
      const result = await git({ cwd: root, args: ['diff', '--no-ext-diff', '--no-textconv', base, '--', `:(literal)${origin.path}`] });
      requireValue(result.exitCode === 0, 'host.evidence_diff', 'source_unavailable');
      return Buffer.from(result.stdout);
    }
    requireValue(origin.kind === 'file', 'host.evidence_origin', 'unsupported');
    let resolved;
    try { ({ resolved } = await resolveReadablePath(requested, root)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      requireValue(before.isFile() && before.size <= MAX_EVIDENCE_BYTES, 'host.evidence_size');
      const content = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < content.length) {
        const read = await handle.read(content, offset, content.length - offset, offset);
        requireValue(read.bytesRead > 0, 'host.evidence_changed', 'conflict');
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      requireValue(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs &&
        await realpath(requested) === resolved, 'host.evidence_changed', 'conflict');
      return content;
    } finally { await handle.close(); }
  }
  return {
    checkpoint,
    async target({ handoffId }) { return (await handoffContext(handoffId)).target; },
    async capture({ threadId, kind, path: relativePath }) {
      requireValue(kind === 'file' || kind === 'diff', 'host.evidence_origin', 'unsupported');
      const current = await context(threadId);
      const origin = kind === 'file' ? { kind, path: relativePath } : { kind, path: relativePath, repoKey: current.target.repoKey };
      const content = await bytes(current.root, origin, current.target);
      requireValue(content !== null, 'host.evidence_missing', 'source_unavailable');
      verifyCurrentTarget(current.target, (await context(threadId)).target);
      const record = registerEvidence({ bytes: content, origin, target: current.target });
      const stored = { threadId, record };
      records.set(key(stored), stored);
      return record;
    },
    async page({ handoffId, ref: input, currentTarget, offset = 0, length = 4096 }) {
      const ref = parseEvidenceRef(input), value = checkpoint(handoffId);
      const current = await handoffContext(handoffId);
      verifyCurrentTarget(currentTarget, current.target);
      const admitted = value.evidence.find(item => item.hash === ref.hash);
      requireValue(admitted && JSON.stringify(admitted) === JSON.stringify(ref), 'host.evidence_reference', 'unauthorized');
      const captured = [...records.values()].find(item => item.threadId === value.scope.threadId &&
        item.record.hash === ref.hash && value.entries.some(entry => entry.evidence?.hash === ref.hash &&
          JSON.stringify(entry.origin) === JSON.stringify(item.record.origin)));
      const content = captured ? await bytes(current.root, captured.record.origin, current.target) : null;
      verifyCurrentTarget(current.target, (await handoffContext(handoffId)).target);
      const query = createEvidenceQuery({
        resolveTarget: () => current.target,
        readEvidence: () => content === null ? null : { bytes: content, totalBytes: content.length },
      });
      try {
        query.publish(value);
        const result = query.callTool({ name: 'context.evidence.page', arguments: {
          checkpointId: value.checkpointId, scope: value.scope, hash: ref.hash, offset, length,
        } });
        if (!result.available) return result;
        const { bytes: page, ...metadata } = result;
        return { ...metadata, encoding: 'base64', data: Buffer.from(page).toString('base64') };
      } finally { query.close(); }
    },
    exportRecords: () => [...records.values()],
    restoreRecords(values) {
      for (const value of values) {
        parseEvidenceRef({ hash: value.record.hash, bytes: value.record.bytes, target: value.record.target });
        parseEvidenceOrigin(value.record.origin);
        records.set(key(value), value);
      }
    },
    recordId: key,
  };
}
