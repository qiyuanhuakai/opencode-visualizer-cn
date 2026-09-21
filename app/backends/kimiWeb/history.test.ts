import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { KimiWebMessage } from '../../utils/kimiWeb';
import { KimiWebError, KimiWebTransportError } from '../../utils/kimiWeb';
import { collectKimiWebHistoryMessages, type KimiWebHistoryPage } from './history';
import { isInjectionMessage, kimiWebMessagesToHistoryEntries } from './historyEntries';

// The fixture is a verbatim capture of kimi web 0.43.0 `GET …/messages`
// (Todo 13 live capture) — reverse-chronological, `has_more:false`, one
// `metadata.origin.kind==='injection'` user message and `role:'tool'` results
// that must fold into the matching assistant `tool_use` parts.

const FIXTURES_DIR = [
  join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures'),
  join(process.cwd(), 'backends', 'kimiWeb', 'fixtures'),
].find((directory) => existsSync(directory)) ?? join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures');

const SESSION_ID = 'session_e0158012-f869-4d98-b4d4-5921a8686e24';

function fixtureMessages(): KimiWebMessage[] {
  const raw = JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'rest-messages-after-p3.json'), 'utf8'),
  ) as { data: { items: KimiWebMessage[] } };
  return raw.data.items;
}

function expectedChronologicalIds(messages: KimiWebMessage[]): string[] {
  return [...messages]
    .reverse()
    .filter((message) => !isInjectionMessage(message))
    .map((message) => message.id);
}

describe('collectKimiWebHistoryMessages', () => {
  it('pages backwards until has_more is false, then returns chronological messages', async () => {
    const newestFirst = fixtureMessages();
    const pageOne = newestFirst.slice(0, 6);
    const pageTwo = newestFirst.slice(6);
    const fetchPage = vi.fn(
      async (_sessionId: string, query?: { before_id?: string }) =>
        query?.before_id
          ? { items: pageTwo, has_more: false }
          : { items: pageOne, has_more: true },
    );

    const result = await collectKimiWebHistoryMessages({ sessionId: SESSION_ID, fetchPage });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[0]?.[1]?.before_id).toBeUndefined();
    // The next page is requested from the OLDEST item of the reverse page.
    expect(fetchPage.mock.calls[1]?.[1]?.before_id).toBe(pageOne.at(-1)?.id);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.messages.map((message) => message.id)).toEqual(
      expectedChronologicalIds(newestFirst),
    );
  });

  it('filters injection-origin user messages out of the stitched history', async () => {
    const newestFirst = fixtureMessages();
    const fetchPage = vi.fn(async () => ({ items: newestFirst, has_more: false }));

    const result = await collectKimiWebHistoryMessages({ sessionId: SESSION_ID, fetchPage });

    expect(result.messages).toHaveLength(expectedChronologicalIds(newestFirst).length);
    expect(result.messages.some((message) => isInjectionMessage(message))).toBe(false);
    expect(result.messages.some((message) => message.id.endsWith('_000001'))).toBe(false);
  });

  it('bounds the page loop and reports truncation when the cap is hit', async () => {
    const newestFirst = fixtureMessages();
    const fetchPage = vi.fn(async () => ({ items: [newestFirst[1]!], has_more: true }));

    const result = await collectKimiWebHistoryMessages({
      sessionId: SESSION_ID,
      fetchPage,
      maxPages: 3,
    });

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('stops paging when the generation fence reports the load is superseded', async () => {
    const fetchPage = vi.fn(async () => ({ items: fixtureMessages(), has_more: false }));

    const result = await collectKimiWebHistoryMessages({
      sessionId: SESSION_ID,
      fetchPage,
      shouldContinue: () => false,
    });

    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.messages).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('rejects a malformed page instead of silently truncating', async () => {
    const fetchPage = vi.fn(
      async () => ({ has_more: true }) as unknown as KimiWebHistoryPage,
    );

    await expect(
      collectKimiWebHistoryMessages({ sessionId: SESSION_ID, fetchPage }),
    ).rejects.toBeInstanceOf(KimiWebTransportError);
  });

  it('propagates a business envelope error raised mid-pagination', async () => {
    const newestFirst = fixtureMessages();
    let calls = 0;
    const fetchPage = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { items: newestFirst.slice(0, 6), has_more: true };
      throw new KimiWebError(40401, 'session missing');
    });

    await expect(
      collectKimiWebHistoryMessages({ sessionId: SESSION_ID, fetchPage }),
    ).rejects.toBeInstanceOf(KimiWebError);
  });
});

describe('kimiWebMessagesToHistoryEntries', () => {
  it('converts the real page into chronological loadHistory entries without tool-role rows', () => {
    const newestFirst = fixtureMessages();
    const chronological = [...newestFirst]
      .reverse()
      .filter((message) => !isInjectionMessage(message));

    const entries = kimiWebMessagesToHistoryEntries(chronological);

    const expectedEntryIds = chronological
      .filter((message) => message.role !== 'tool')
      .map((message) => message.id);
    expect(entries.map((entry) => entry.info.id)).toEqual(expectedEntryIds);
    expect(entries.every((entry) => entry.info.role === 'user' || entry.info.role === 'assistant')).toBe(
      true,
    );
    // 2 tool rows fold into their assistant `tool_use`; the injection user is dropped.
    expect(entries).toHaveLength(8);
    expect(entries.some((entry) => entry.info.id.endsWith('_000001'))).toBe(false);
  });

  it('maps assistant thinking/text parts and folds tool results into tool parts', () => {
    const chronological = [...fixtureMessages()]
      .reverse()
      .filter((message) => !isInjectionMessage(message));
    const entries = kimiWebMessagesToHistoryEntries(chronological);

    const assistant = entries.find((entry) => entry.info.id.endsWith('_000008'));
    expect(assistant?.parts.some((part) => part.type === 'reasoning')).toBe(true);
    expect(assistant?.parts.some((part) => part.type === 'text')).toBe(true);

    const toolHost = assistant;
    const toolPart = toolHost?.parts.find((part) => part.type === 'tool');
    expect(toolPart?.type === 'tool' && toolPart.callID).toBe('tool_3ydieXPUScwcnZ3KzDPcfeDx');
    expect(toolPart?.type === 'tool' && toolPart.state.status).toBe('completed');
    if (toolPart?.type === 'tool' && toolPart.state.status === 'completed') {
      expect(toolPart.state.output).toContain('agent_id: agent-0');
    }
  });
});
