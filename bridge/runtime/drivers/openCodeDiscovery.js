import { randomUUID } from 'node:crypto';
import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { OPEN_CODE_LIMITS, summary, pageLimit, discoveryScope } from '../../../shared/runtime/native/opencode/protocol.js';

/** Events are revision fences over provisional native pages, never a second full catalog. */
export function createOpenCodeDiscovery({ reader, request, current, assertCurrent, cursorApi }) {
  const storeReader = cursorApi ? undefined : reader;
  const scans = new Map();
  let failure = null;
  let closed = false;
  const same = (left, right) => left.epoch === right.epoch && left.processGeneration === right.processGeneration;
  const partial = (reason, items = []) => ({ items, cursor: null, completeness: items.length ? 'partial' : 'unsupported', reason, retryable: true, ...current() });
  const inScope = (row, scope) => (scope.projectID === undefined || row.projectID === scope.projectID)
    && (scope.directory === undefined || row.directory === scope.directory)
    && (scope.parentID === undefined || row.parentID === scope.parentID)
    && (scope.roots !== true || row.parentID === undefined)
    && (scope.archived === undefined || Boolean(row.time.archived) === scope.archived);
  async function apiPage(limit, scan) {
    const { scope, nativeCursor } = scan;
    const result = await request('/api/session', { query: { limit, order: 'asc', project: scope.projectID, directory: scope.directory, cursor: nativeCursor ?? undefined } });
    requireValue(Array.isArray(result?.data) && result.data.length <= limit && result.cursor && typeof result.cursor === 'object', 'opencode.cursor_page');
    const cursor = result.cursor.next ?? null;
    requireValue(cursor === null || typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 8192, 'opencode.cursor_page');
    const items = result.data.map(row => {
      requireValue(typeof row?.location?.directory === 'string', 'opencode.cursor_directory');
      return summary({ ...row, directory: row.location.directory, version: cursorApi });
    });
    return { items, cursor, completeness: cursor ? 'partial' : 'complete', reason: cursor ? 'more-pages' : 'native-api-eof', provenance: { nativeVersion: cursorApi, summaryOnly: true } };
  }
  function reconcileRow(scan, item) {
    const overlay = scan.overlay.get(item.id);
    if (!overlay) return { summary: item, revision: scan.seq };
    scan.overlay.delete(item.id);
    scan.bytes -= overlay.bytes;
    const event = overlay.event;
    if (event.type === 'session.deleted') return null;
    const update = event.summary;
    if (!update || update.time.updated <= item.time.updated) return { summary: item, revision: scan.seq };
    if (update.projectID !== item.projectID || update.directory !== item.directory || update.parentID !== item.parentID
      || update.time.archived !== item.time.archived) scan.invalid ??= 'native-source-changed';
    return { summary: update, revision: event.seq };
  }
  return {
    invalidate(reason) { failure = reason; for (const scan of scans.values()) scan.invalid = reason; },
    event(event) {
      if (!same(event, current())) return;
      for (const scan of scans.values()) {
        if (event.type !== 'session.updated' || !event.session || !event.summary) scan.invalid ??= 'native-source-changed';
        if (!event.session) continue;
        const key = event.session.nativeSessionId;
        const size = Buffer.byteLength(JSON.stringify(event));
        const previous = scan.overlay.get(key);
        if (event.type === 'session.updated' && (previous?.event.type === 'session.deleted'
          || (previous?.event.summary && event.summary && previous.event.summary.time.updated > event.summary.time.updated))) continue;
        scan.bytes += size - (previous?.bytes ?? 0);
        if (scan.bytes > OPEN_CODE_LIMITS.producer) { scan.invalid = 'native-buffer-overflow'; scan.overlay.clear(); scan.bytes = 0; failure = scan.invalid; continue; }
        scan.overlay.set(key, { event, bytes: size });
      }
    },
    async listSessionPage(params = {}) {
      requireValue(!closed, 'opencode.discovery_closed', 'source_unavailable');
      const limit = pageLimit(params.limit); const scope = discoveryScope(params.scope);
      await assertCurrent();
      const generation = current();
      for (const [key, scan] of scans) if (scan.expiresAt <= Date.now()) scans.delete(key);
      let scan;
      if (params.cursor != null) {
        scan = scans.get(params.cursor);
        if (!scan || JSON.stringify(scan.scope) !== JSON.stringify(scope) || !same(scan, generation)) return partial('expired-or-repeated-cursor');
        scans.delete(params.cursor);
      } else {
        requireValue(scans.size < 3, 'opencode.discovery_snapshots', 'reconcile_required');
        scan = { ...generation, scope, nativeCursor: null, overlay: new Map(), bytes: 0, expiresAt: Date.now() + 60000, invalid: null };
      }
      // Install before awaiting the worker: a delete racing the first page is also fenced.
      const token = randomUUID(); scans.set(token, scan);
      try {
        if (!storeReader && !cursorApi) throw new ProtocolError('unsupported', 'opencode.store_unavailable');
        const page = storeReader ? await storeReader.page({ limit, scope, cursor: scan.nativeCursor }) : await apiPage(limit, scan);
        await assertCurrent();
        if (!same(scan, current())) throw new ProtocolError('reconcile_required', 'opencode.generation');
        const seen = new Set();
        const items = [];
        for (const native of page.items) {
          const item = summary(native);
          const ordered = storeReader
            ? scan.lastId === undefined || Buffer.compare(Buffer.from(item.id), Buffer.from(scan.lastId)) > 0
            : item.id !== scan.lastId && (scan.lastCreated === undefined || item.time.created >= scan.lastCreated);
          requireValue(!seen.has(item.id) && ordered, 'opencode.repeated_page', 'reconcile_required');
          seen.add(item.id);
          scan.lastId = item.id;
          scan.lastCreated = item.time.created;
          const row = reconcileRow(scan, item);
          if (row && inScope(row.summary, scope)) items.push(row);
        }
        requireValue(page.cursor === null || (page.cursor !== scan.nativeCursor && page.items.length > 0), 'opencode.repeated_cursor', 'reconcile_required');
        scan.nativeCursor = page.cursor;
        // An update without a native row may have moved into or out of this scan's scope.
        const unverified = page.cursor === null && scan.overlay.size > 0;
        const invalid = scan.invalid ?? failure ?? (unverified ? 'native-source-changed' : null);
        const more = page.cursor !== null && !invalid;
        if (more) scan.expiresAt = Date.now() + 60000;
        else scans.delete(token);
        return { items, cursor: more ? token : null, completeness: invalid ? 'partial' : page.completeness, reason: invalid ?? page.reason, retryable: Boolean(invalid), provenance: page.provenance, ...generation, seq: scan.seq };
      } catch (error) {
        if (!(error instanceof ProtocolError)) { scans.delete(token); throw error; }
        await assertCurrent();
        // No cursor semantics have been proven for /session. A finite sample remains explicitly partial.
        if (error.field === 'opencode.store_changed' || params.cursor != null || scan.nativeCursor !== null) { scans.delete(token); return { ...partial(error.field), completeness: 'partial' }; }
        try {
          const rows = await request('/session', { query: { directory: scope.directory ?? '/', scope: 'project', limit } });
          await assertCurrent();
          requireValue(same(generation, current()), 'opencode.generation', 'reconcile_required');
          requireValue(Array.isArray(rows), 'opencode.session_list');
          const seen = new Set();
          const items = rows.slice(0, limit).map(summary).filter((row) => {
            if (seen.has(row.id)) return false;
            seen.add(row.id);
            return inScope(row, scope);
          }).map(row => reconcileRow(scan, row)).filter(Boolean);
          return { ...partial(`api-enumeration-unproven:${error.field}`, items), completeness: 'partial' };
        } catch (apiError) {
          if (!(apiError instanceof ProtocolError)) throw apiError;
          return partial(`${error.field}:${apiError.field}`);
        } finally { scans.delete(token); }
      }
    },
    retry() { failure = null; scans.clear(); },
    close() { closed = true; scans.clear(); },
  };
}
