import { describe, expect, it, vi } from 'vitest';
import {
  DSH_DELETE_UNSUPPORTED_REASON,
  DshSessionDeleteUnsupportedError,
  archiveDshSession,
  deleteDshSession,
  forkDshSession,
  pinDshSession,
  renameDshSession,
  unarchiveDshSession,
  unpinDshSession,
  type DshSessionActionApi,
} from './dshSessionActions';

/**
 * Build a fully-instrumented dsh action seam. Every call is recorded in `order`
 * so the fork archive-restore / stream re-subscription SEQUENCE can be asserted
 * (a set-based `toHaveBeenCalled` cannot prove ordering).
 */
function createActionApi(overrides: Partial<DshSessionActionApi> = {}) {
  const order: string[] = [];
  const api: DshSessionActionApi = {
    renameSession: vi.fn(async (sessionId: string, title: string) => {
      order.push(`rename:${sessionId}:${title}`);
      return {};
    }),
    forkSession: vi.fn(async (sessionId: string, atSeq?: number) => {
      order.push(`fork:${sessionId}:${atSeq ?? ''}`);
      return { sessionId: 'fork-1' };
    }),
    archiveSession: vi.fn(async (sessionId: string) => {
      order.push(`archive:${sessionId}`);
      return {};
    }),
    unarchiveSession: vi.fn(async (sessionId: string) => {
      order.push(`unarchive:${sessionId}`);
      return {};
    }),
    pinSession: vi.fn(async (sessionId: string) => {
      order.push(`pin:${sessionId}`);
      return {};
    }),
    unpinSession: vi.fn(async (sessionId: string) => {
      order.push(`unpin:${sessionId}`);
      return {};
    }),
    followSession: vi.fn(async (sessionId: string) => {
      order.push(`follow:${sessionId}`);
      return { archived: false };
    }),
    disposeSessionFollow: vi.fn((sessionId: string) => {
      order.push(`dispose:${sessionId}`);
    }),
    ...overrides,
  };
  return { api, order };
}

describe('dshSessionActions wire mapping', () => {
  it('rename writes the title through session/rename with the session id', async () => {
    const { api } = createActionApi();
    await renameDshSession(api, 'session-1', 'Renamed');
    expect(api.renameSession).toHaveBeenCalledWith('session-1', 'Renamed');
  });

  it('archive/unarchive map to the workspace session endpoints', async () => {
    const { api, order } = createActionApi();
    await archiveDshSession(api, 'session-1');
    await unarchiveDshSession(api, 'session-1');
    expect(order).toEqual(['archive:session-1', 'unarchive:session-1']);
  });

  it('pin/unpin map to the workspace pin endpoints', async () => {
    const { api, order } = createActionApi();
    await pinDshSession(api, 'session-1');
    await unpinDshSession(api, 'session-1');
    expect(order).toEqual(['pin:session-1', 'unpin:session-1']);
  });
});

describe('dshSessionActions delete refusal', () => {
  it('delete refuses with the documented reason because dsh has no server delete endpoint', () => {
    expect(() => deleteDshSession()).toThrow(DshSessionDeleteUnsupportedError);
    expect(DSH_DELETE_UNSUPPORTED_REASON).toContain('no session delete endpoint');
  });

  it('the refusal names the reason so a caller never sees a silent no-op', () => {
    try {
      deleteDshSession();
      throw new Error('deleteDshSession should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DshSessionDeleteUnsupportedError);
      expect((error as DshSessionDeleteUnsupportedError).reason).toContain(
        'no session delete endpoint',
      );
    }
  });
});

describe('dshSessionActions fork archive restoration', () => {
  it('Given a forked snapshot that reports archived, When forkDshSession runs, Then fork ack -> dispose old stream -> follow new stream -> unarchive', async () => {
    const { api, order } = createActionApi({
      followSession: vi.fn(async (sessionId: string) => {
        order.push(`follow:${sessionId}`);
        return { archived: true };
      }),
    });

    const outcome = await forkDshSession(api, 'session-1', 7);

    expect(outcome).toEqual({ sessionId: 'fork-1', archivedRestored: true });
    // R7: the stale follow stream is disposed BEFORE the fresh one is opened, and
    // the fork's snapshot is read from the NEW stream — never shared/reused.
    // docs/dsh.md: the fork snapshot copies the source's `archived` flag and dsh
    // has no server-side unarchive, so the unarchive MUST follow the fork ack.
    expect(order).toEqual([
      'fork:session-1:7',
      'dispose:session-1',
      'follow:fork-1',
      'unarchive:fork-1',
    ]);
    expect(api.forkSession).toHaveBeenCalledWith('session-1', 7);
    expect(api.disposeSessionFollow).toHaveBeenCalledWith('session-1');
    expect(api.followSession).toHaveBeenCalledWith('fork-1');
    expect(api.unarchiveSession).toHaveBeenCalledWith('fork-1');
  });

  it('Given a forked snapshot that is not archived, When forkDshSession runs, Then no unarchive is injected', async () => {
    const { api, order } = createActionApi();
    const outcome = await forkDshSession(api, 'session-1');
    expect(outcome).toEqual({ sessionId: 'fork-1', archivedRestored: false });
    expect(order).toEqual(['fork:session-1:', 'dispose:session-1', 'follow:fork-1']);
    expect(api.unarchiveSession).not.toHaveBeenCalled();
  });

  it('Given a fork response without a session id, When forkDshSession runs, Then it fails loudly', async () => {
    const { api } = createActionApi({ forkSession: vi.fn(async () => ({})) });
    await expect(forkDshSession(api, 'session-1')).rejects.toThrow(/no sessionId/);
  });
});
