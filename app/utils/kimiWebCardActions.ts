import type { MessageDiffEntry } from '../types/message';
import type { KimiWebClient, KimiWebMessage } from './kimiWeb';

type CardClient = Pick<KimiWebClient, 'getSessionStatus' | 'getMessages' | 'forkSession' | 'deleteSession' | 'undoSession' | 'getTranscript' | 'getTurnFileChanges' | 'getTurnFileContent'>;
function isAnchor(message: KimiWebMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.metadata?.origin;
  if (origin?.inTurn === true) return false;
  return !origin || origin.kind === 'user' ||
    (['skill_activation', 'plugin_command'].includes(String(origin.kind)) && origin.trigger === 'user-slash');
}
export function createKimiWebCardActions(client: CardClient) {
  async function ensureIdle(id: string) {
    if ((await client.getSessionStatus(id)).busy) throw new Error('Kimi session is busy. Stop the current turn before changing its checkpoint.');
  }
  async function undoCount(id: string, messageId: string) {
    let beforeId: string | undefined;
    let count = 0;
    const cursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await client.getMessages(id, { before_id: beforeId, page_size: 100 });
      for (const message of page.items) {
        if (String(message.metadata?.origin?.kind) === 'compaction_summary') throw new Error('Cannot undo across a compaction checkpoint.');
        if (isAnchor(message)) count++;
        if (message.id === messageId) {
          if (!isAnchor(message)) throw new Error('This message is not an independent user checkpoint.');
          return count;
        }
      }
      if (!page.has_more) break;
      beforeId = page.items.at(-1)?.id;
      if (!beforeId || cursors.has(beforeId)) break;
      cursors.add(beforeId);
    }
    throw new Error('The selected message checkpoint is no longer available.');
  }
  async function undoSessionFromMessage(id: string, messageId: string) {
    await ensureIdle(id);
    const count = await undoCount(id, messageId);
    await ensureIdle(id);
    await client.undoSession(id, count);
  }
  async function forkSessionAtMessage(id: string, messageId: string) {
    await ensureIdle(id);
    await undoCount(id, messageId);
    const clone = await client.forkSession(id);
    try {
      await undoSessionFromMessage(clone.id, messageId);
      return clone;
    } catch (error) {
      try { await client.deleteSession(clone.id); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Checkpoint fork failed; could not remove incomplete branch ${clone.id}.`);
      }
      throw error;
    }
  }
  async function resolveTurn(id: string, messageId: string): Promise<number> {
    let beforeTurn: string | undefined;
    const cursors = new Set<string>();
    const turns: Array<{ ordinal: number; triggerPromptId?: string }> = [];
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await client.getTranscript(id, beforeTurn);
      const turn = page.items.find(item => item.kind === 'turn' && item.triggerPromptId === messageId);
      if (turn && Number.isSafeInteger(turn.ordinal) && turn.ordinal >= 0) return turn.ordinal;
      turns.push(...page.items.filter((item) => item.kind === 'turn' && Number.isSafeInteger(item.ordinal) && item.ordinal >= 0));
      if (!page.has_more) break;
      beforeTurn = page.items.find(item => item.kind === 'turn')?.turnId;
      if (!beforeTurn || cursors.has(beforeTurn)) break;
      cursors.add(beforeTurn);
    }
    const legacyTurns = turns.filter((turn) => !turn.triggerPromptId).sort((a, b) => a.ordinal - b.ordinal);
    if (legacyTurns.length) {
      const anchors: string[] = [];
      let beforeId: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await client.getMessages(id, { before_id: beforeId, page_size: 100 });
        anchors.push(...page.items.filter(isAnchor).map((message) => message.id));
        if (!page.has_more) break;
        beforeId = page.items.at(-1)?.id;
        if (!beforeId) break;
      }
      const chronological = anchors.reverse();
      const firstKnown = turns.filter((turn) => turn.triggerPromptId)
        .sort((a, b) => a.ordinal - b.ordinal)[0];
      const firstKnownIndex = firstKnown ? chronological.indexOf(firstKnown.triggerPromptId ?? '') : chronological.length;
      const legacyIndex = chronological.slice(0, firstKnownIndex).indexOf(messageId);
      if (legacyIndex >= 0 && legacyIndex < legacyTurns.length) return legacyTurns[legacyIndex]!.ordinal;
    }
    throw new Error('The selected turn is not available in the Kimi transcript.');
  }
  async function loadMessageDiffs(id: string, messageId: string): Promise<MessageDiffEntry[]> {
    const turn = await resolveTurn(id, messageId);
    const result = await client.getTurnFileChanges(id, turn);
    if (!result.recorded) return [];
    return Promise.all(result.changes.map(async change => {
      if (change.binary || change.oversize) throw new Error(`Text diff is unavailable for ${change.path} (binary or oversized file).`);
      const [start, end] = await Promise.all([
        client.getTurnFileContent(id, turn, change.path, 'start'),
        client.getTurnFileContent(id, turn, change.path, 'end'),
      ]);
      const before = start.content?.content ?? (change.status === 'added' ? '' : undefined);
      const after = end.content?.content ?? (change.status === 'deleted' ? '' : undefined);
      if (before === undefined || after === undefined || start.content?.binary || end.content?.binary) throw new Error(`File snapshot unavailable: ${change.path}`);
      return { file: change.path, diff: '', before, after };
    }));
  }
  async function hasMessageDiffs(id: string, messageId: string): Promise<boolean> {
    const turn = await resolveTurn(id, messageId);
    const result = await client.getTurnFileChanges(id, turn);
    return result.recorded && result.changes.length > 0;
  }
  return { forkSessionAtMessage, undoSessionFromMessage, loadMessageDiffs, hasMessageDiffs };
}
