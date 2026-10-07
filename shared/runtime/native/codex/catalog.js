import { encodeSessionKey } from '../../identity.js';
import { requireValue } from '../../capabilities.js';

export function createCodexCatalog({ store, sessionFor, assertCurrent, newId, privacy }) {
  let revision = 0;
  const keyFor = (session) => `codex-catalog:${encodeSessionKey(session)}`;
  async function overlay(session) {
    assertCurrent();
    const row = await store.get({ collection: 'artifacts', key: keyFor(session) });
    assertCurrent();
    requireValue(!row?.chunked, 'codex.catalog.overlay');
    return row;
  }
  async function changed(session, method, params = {}) {
    revision++;
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await overlay(session);
      const value = { ...row?.value, kind: 'codex-catalog', session };
      switch (method) {
        case 'thread/deleted':
          value.deleted = true;
          break;
        case 'thread/archived':
          value.archived = true;
          break;
        case 'thread/unarchived':
          value.archived = false;
          break;
        case 'thread/name/updated':
          value.title = params.name ?? params.threadName ?? null;
          break;
        default:
          return;
      }
      try {
        assertCurrent();
        await store.mutate({
          intentId: newId(),
          changes: [
            {
              collection: 'artifacts',
              key: keyFor(session),
              expectedRevision: row?.revision ?? 0,
              value: privacy(value),
            },
          ],
        });
        assertCurrent();
        revision++;
        return;
      } catch (error) {
        if (error?.code !== 'conflict') throw error;
      }
    }
    requireValue(false, 'codex.catalog.concurrent_update', 'conflict');
  }
  async function summary(thread, archived = false) {
    requireValue(typeof thread?.id === 'string', 'codex.thread.id');
    const session = sessionFor(thread.id);
    const row = await overlay(session);
    if (row?.value?.deleted) return null;
    const title = row?.value?.title ?? thread.name ?? thread.preview ?? thread.id;
    return privacy({
      session,
      title: String(title).slice(0, 4096),
      cwd: thread.cwd ?? null,
      archived: row?.value?.archived ?? archived,
      modelProvider: thread.modelProvider ?? null,
      createdAt: thread.createdAt ?? null,
      updatedAt: thread.updatedAt ?? null,
      source: thread.source ?? null,
      agentNickname: thread.agentNickname ?? null,
      agentRole: thread.agentRole ?? null,
    });
  }
  return {
    summary,
    changed,
    invalidate() {
      revision++;
    },
    get revision() {
      return revision;
    },
  };
}
