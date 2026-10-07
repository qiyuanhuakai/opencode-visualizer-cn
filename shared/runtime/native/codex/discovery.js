import { ProtocolError, requireValue } from '../../capabilities.js';

export const SOURCE_KINDS = Object.freeze([
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
]);

/** App Server 0.160: [] explicitly includes every configured provider. */
export function createCodexDiscovery({ request, summary, generation, revision = () => 0 }) {
  const scans = new Map();
  let serial = 0;
  return async function list({ cursor = null, limit = 100 } = {}) {
    requireValue(Number.isInteger(limit) && limit > 0 && limit <= 200, 'codex.list.limit');
    for (const [key, value] of scans) if (value.expires <= Date.now()) scans.delete(key);
    let state;
    if (cursor) {
      state = scans.get(cursor);
      scans.delete(cursor);
      requireValue(state !== undefined, 'codex.list.cursor', 'replay_required');
    } else {
      requireValue(scans.size < 3, 'codex.list.scans', 'conflict');
      state = {
        archived: false,
        native: null,
        seen: new Set(),
        ids: new Set(),
        bytes: 0,
        revision: revision(),
        generation,
        expires: Date.now() + 60000,
      };
    }
    requireValue(
      state.generation === generation && state.expires > Date.now(),
      'codex.list.generation',
      'replay_required',
    );
    try {
      requireValue(
        state.revision === revision(),
        'codex.list.catalog_changed',
        'reconcile_required',
      );
      const page = await request('thread/list', {
        cursor: state.native,
        limit,
        sortKey: 'updated_at',
        archived: state.archived,
        modelProviders: [],
        sourceKinds: SOURCE_KINDS,
        useStateDbOnly: false,
      });
      requireValue(
        page && Array.isArray(page.data) && page.data.length <= limit,
        'codex.list.page',
      );
      const next = page.nextCursor ?? null;
      requireValue(next === null || typeof next === 'string', 'codex.list.cursor');
      if (next && (next === state.native || state.seen.has(next)))
        throw new ProtocolError('reconcile_required', 'codex.list.repeated_cursor');
      const candidates = await Promise.all(
        page.data.map((thread) => summary(thread, state.archived)),
      );
      requireValue(
        state.revision === revision(),
        'codex.list.catalog_changed',
        'reconcile_required',
      );
      const items = [];
      for (const item of candidates) {
        if (!item || state.ids.has(item.session.nativeSessionId)) continue;
        state.bytes += new TextEncoder().encode(item.session.nativeSessionId).length;
        requireValue(
          state.bytes <= 8 * 1024 * 1024,
          'codex.list.identity_budget',
          'reconcile_required',
        );
        state.ids.add(item.session.nativeSessionId);
        items.push(item);
      }
      if (next) {
        requireValue(state.seen.size < 10000, 'codex.list.cursor_budget', 'reconcile_required');
        state.native = next;
        state.seen.add(next);
      } else if (!state.archived) {
        state.archived = true;
        state.native = null;
        state.seen.clear();
      } else return { items, cursor: null, completeness: 'complete' };
      const token = `${generation}:${++serial}`;
      scans.set(token, state);
      return { items, cursor: token, completeness: 'partial', reason: 'more_pages' };
    } catch (error) {
      return {
        items: [],
        cursor: null,
        completeness:
          error instanceof ProtocolError && error.code === 'unsupported'
            ? 'unsupported'
            : 'partial',
        reason: error instanceof ProtocolError ? error.field : 'codex.source_unavailable',
      };
    }
  };
}
