import { describe, expect, it } from 'vitest';
import type { DshNormalizeOp } from '../backends/dsh/ops';
import type { ProjectState, SessionState } from '../types/worker-state';
import {
  applyDshSessionEvent,
  createDshSessionEventHub,
  dshPromptRunningChange,
  dshSessionPid,
  mapDshEventSession,
  normalizeDshSessionEvent,
} from './dshSessionEvents';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sessionFixture(overrides: Partial<SessionState> & { id: string }): SessionState {
  return { title: overrides.id, ...overrides };
}

function projectsFixture(): Record<string, ProjectState> {
  return {
    'ws-1': {
      id: 'ws-1',
      name: 'repo',
      worktree: '/repo',
      sandboxes: {
        '/repo': {
          directory: '/repo',
          name: 'repo',
          rootSessions: ['s1', 's2', 'archived-1'],
          sessions: {
            s1: sessionFixture({ id: 's1', title: 'Session one', status: 'unknown' }),
            s2: sessionFixture({ id: 's2', title: 'Session two', status: 'unknown' }),
            'archived-1': sessionFixture({
              id: 'archived-1',
              title: 'Archived',
              status: 'unknown',
              timeArchived: 5,
            }),
          },
        },
      },
    },
  };
}

function entryOf(projects: Record<string, ProjectState>, sessionId: string): SessionState {
  const entry = Object.values(projects)
    .flatMap((project) => Object.values(project.sandboxes))
    .map((sandbox) => sandbox.sessions[sessionId])
    .find(Boolean);
  if (!entry) throw new Error(`fixture has no session ${sessionId}`);
  return entry;
}

it('places a discovered child in its parent sandbox during live delivery and replay', () => {
  for (const origin of ['live', 'snapshot-rebuild'] as const) {
    const projects = projectsFixture();
    const change = normalizeDshSessionEvent({ kind: 'subagent-discovered', parentSessionId: 's1',
      childSessionId: 'actual-child', mode: 'one-shot', title: 'Tiny task', createdAt: 42 }, { origin });
    expect(change).toBeDefined();
    if (!change) throw Error('catalog discovery missing');
    applyDshSessionEvent(projects, change);
    expect(entryOf(projects, 'actual-child')).toMatchObject({ parentID: 's1', title: 'Tiny task', timeCreated: 42 });
    expect(projects['ws-1'].sandboxes['/repo'].rootSessions).not.toContain('actual-child');
  }
});

function turnOp(
  sessionId: string,
  phase: 'started' | 'ended',
  overrides: Partial<Extract<DshNormalizeOp, { kind: 'turn' }>> = {},
): DshNormalizeOp {
  return { kind: 'turn', phase, sessionId, turn: 1, time: 1_000, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dsh session events: pid empty-string guard', () => {
  it('maps a dsh session without pid to the empty-string pid (never undefined)', () => {
    // dsh session/list reports NO pid: the mapping layer must default to ''.
    const mapped = mapDshEventSession({ sessionId: 's1', workspaceId: 'ws-1', cwd: '/repo' });
    expect(mapped?.pid).toBe('');
    expect(mapped?.pid).not.toBeUndefined();
    // useSessionDisplayInfo-equivalent: a `pid.startsWith(...)` call must not throw.
    expect(() => mapped?.pid.startsWith('pid:')).not.toThrow();
    expect(mapped?.pid.startsWith('pid:')).toBe(false);
  });

  it('normalizes every inbox/thread event with the empty-string pid default', () => {
    const ops: DshNormalizeOp[] = [
      turnOp('s1', 'started'),
      turnOp('s1', 'ended', { reason: { kind: 'completed' } }),
      { kind: 'session-title', sessionId: 's1', title: 'T', messageSeqs: [1], sourceKind: 'fallback', time: 2 },
      { kind: 'user-message', sessionId: 's1', messageId: 'm1', sourceKind: 'user', role: 'user', time: 3 },
    ];
    for (const op of ops) {
      const change = normalizeDshSessionEvent(op);
      expect(change?.pid).toBe('');
      expect(change?.pid).not.toBeUndefined();
      expect(() => change?.pid.startsWith('x')).not.toThrow();
    }
  });

  it('defaults odd pid values to the empty string and keeps real strings', () => {
    expect(dshSessionPid(undefined)).toBe('');
    expect(dshSessionPid(null)).toBe('');
    expect(dshSessionPid(42)).toBe('');
    expect(dshSessionPid({})).toBe('');
    expect(dshSessionPid('  ')).toBe('');
    expect(dshSessionPid('pid-7')).toBe('pid-7');
    expect(dshPromptRunningChange('s1').pid).toBe('');
  });
});

describe('dsh session events: status semantics', () => {
  it('keeps a never-run session Unknown until a turn starts, then Busy, then Idle', () => {
    const projects = projectsFixture();
    applyDshSessionEvent(projects, normalizeDshSessionEvent(turnOp('s1', 'started'))!);
    expect(entryOf(projects, 's1').status).toBe('busy');
    applyDshSessionEvent(
      projects,
      normalizeDshSessionEvent(turnOp('s1', 'ended', { reason: { kind: 'completed' } }))!,
    );
    expect(entryOf(projects, 's1').status).toBe('idle');
  });

  it('treats turn/end.reason.kind as the authoritative completion signal', () => {
    const projects = projectsFixture();
    const errored = normalizeDshSessionEvent(
      turnOp('s1', 'ended', { reason: { kind: 'error', code: 'MISSING_CREDENTIAL' } }),
    );
    expect(errored?.reason).toMatchObject({ kind: 'error', code: 'MISSING_CREDENTIAL' });
    applyDshSessionEvent(projects, normalizeDshSessionEvent(turnOp('s1', 'started'))!);
    applyDshSessionEvent(projects, errored!);
    expect(entryOf(projects, 's1').status).toBe('idle');

    const aborted = normalizeDshSessionEvent(turnOp('s2', 'started'));
    applyDshSessionEvent(projects, aborted!);
    applyDshSessionEvent(
      projects,
      normalizeDshSessionEvent(turnOp('s2', 'ended', { reason: { kind: 'aborted' } }))!,
    );
    expect(entryOf(projects, 's2').status).toBe('idle');
  });

  it('never shows Idle for a session that has not run in this connection', () => {
    const projects = projectsFixture();
    // A turn/end for a session this connection never saw starting (attach
    // mid-session, or a stale frame) must not fabricate the Idle state.
    applyDshSessionEvent(
      projects,
      normalizeDshSessionEvent(turnOp('s1', 'ended', { reason: { kind: 'completed' } }))!,
    );
    expect(entryOf(projects, 's1').status).toBe('unknown');
  });

  it('does not fabricate transient state from snapshot rebuilds', () => {
    const projects = projectsFixture();
    // Replayed turns carry no session-visible state: the normalizer drops them.
    expect(
      normalizeDshSessionEvent(turnOp('s1', 'started'), { origin: 'snapshot-rebuild' }),
    ).toBeUndefined();
    expect(
      normalizeDshSessionEvent(
        { kind: 'user-message', sessionId: 's1', messageId: 'm1', sourceKind: 'user', role: 'user', time: 1 },
        { origin: 'snapshot-rebuild' },
      ),
    ).toBeUndefined();
    expect(entryOf(projects, 's1').status).toBe('unknown');
    expect(entryOf(projects, 's1').timeUpdated).toBeUndefined();
    // Durable fields still apply: the snapshot title is authoritative.
    applyDshSessionEvent(
      projects,
      normalizeDshSessionEvent(
        { kind: 'session-title', sessionId: 's1', title: 'Renamed', messageSeqs: [1], sourceKind: 'fallback', time: 2 },
        { origin: 'snapshot-rebuild' },
      )!,
    );
    expect(entryOf(projects, 's1').title).toBe('Renamed');
  });

  it('updates the title from session/title and touches activity time on live inbox events', () => {
    const projects = projectsFixture();
    applyDshSessionEvent(
      projects,
      normalizeDshSessionEvent({
        kind: 'session-title', sessionId: 's1', title: 'Renamed', messageSeqs: [8], sourceKind: 'fallback', time: 4_242,
      })!,
    );
    expect(entryOf(projects, 's1').title).toBe('Renamed');
    applyDshSessionEvent(
      projects,
      normalizeDshSessionEvent({
        kind: 'user-message', sessionId: 's1', messageId: 'm1', sourceKind: 'user', rpcId: 'r1', role: 'user', time: 4_244,
      })!,
    );
    expect(entryOf(projects, 's1').timeUpdated).toBe(4_244);
  });

  it('ignores event kinds that carry no session-visible state', () => {
    const step: DshNormalizeOp = { kind: 'step', phase: 'started', sessionId: 's1', turn: 1, step: 1, time: 9 };
    const system: DshNormalizeOp = { kind: 'system-message', sessionId: 's1', turn: 1, step: 1, role: 'system', text: '…', time: 9 };
    expect(normalizeDshSessionEvent(step)).toBeUndefined();
    expect(normalizeDshSessionEvent(system)).toBeUndefined();
  });
});

describe('dsh session events: cross-session isolation', () => {
  it('keeps two sessions inbox/thread events from overwriting each other', () => {
    const projects = projectsFixture();
    const apply = (op: DshNormalizeOp) =>
      applyDshSessionEvent(projects, normalizeDshSessionEvent(op)!);

    apply(turnOp('s1', 'started'));
    apply(turnOp('s2', 'started'));
    apply({ kind: 'user-message', sessionId: 's2', messageId: 'm2', sourceKind: 'user', role: 'user', time: 10 });
    apply(turnOp('s1', 'ended', { reason: { kind: 'completed' } }));

    expect(entryOf(projects, 's1').status).toBe('idle');
    expect(entryOf(projects, 's1').timeUpdated).toBe(1_000);
    expect(entryOf(projects, 's2').status).toBe('busy');
    expect(entryOf(projects, 's2').timeUpdated).toBe(10);
    expect(entryOf(projects, 's2').title).toBe('Session two');
  });

  it('routes a child subagent terminal to the parent without touching siblings', () => {
    const projects = projectsFixture();
    applyDshSessionEvent(
      projects,
      normalizeDshSessionEvent({
        kind: 'subagent', phase: 'terminal', parentSessionId: 's1', childSessionId: 'child-1', mode: 'general', turn: 2, time: 77,
      })!,
    );
    expect(entryOf(projects, 's1').timeUpdated).toBe(77);
    expect(entryOf(projects, 's2').timeUpdated).toBeUndefined();
  });
});

describe('dsh session events: shared transport hub', () => {
  it('fans ONE subscription out to every session (no per-session transports)', () => {
    const hub = createDshSessionEventHub();
    const seen: string[] = [];
    const unsubscribe = hub.onSessionEvent((op) => seen.push(op.kind));
    expect(hub.onSessionEvent).toBeTypeOf('function');
    hub.emitSessionEvent(turnOp('s1', 'started'));
    hub.emitSessionEvent(turnOp('s2', 'started'));
    hub.emitPromptRunning('s1');
    const running: string[] = [];
    hub.onPromptRunning((sessionId) => running.push(sessionId));
    hub.emitPromptRunning('s2');
    unsubscribe();
    hub.emitSessionEvent(turnOp('s1', 'ended', { reason: { kind: 'completed' } }));
    expect(seen).toEqual(['turn', 'turn']);
    expect(running).toEqual(['s2']);
  });
});
