/**
 * PR #191 review regressions — the Thread UI composable and its two presentational components.
 *
 * Each test below reproduces one reviewer finding against the REAL product: the real
 * useRuntimeThread composable, the real bridge Thread/Handoff/Checkpoint services, and the real
 * ParticipantPicker / ContextEvidenceView SFCs mounted over happy-dom.
 *
 * The expected values were derived by driving the unmodified product first, so every assertion
 * pins a behaviour that was actually observed before the fix.
 */
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import type { RepoRef, SessionRef } from '../../shared/runtime/identity.js';
import type { ThreadService, ThreadRecord } from '../../bridge/runtime/threads/threadService.js';
import type { ThreadSessionSource } from '../../shared/runtime/thread.js';
import { createThreadService } from '../../bridge/runtime/threads/threadService.js';
import { createTurnTimeline } from '../runtime/timeline';
import { createRuntimeThreadState } from './useRuntimeThread';
import type { RuntimeHandoffPort, RuntimeThreadState } from './useRuntimeThread';
import { evidenceHash } from '../../shared/runtime/context.js';
import type { ContextCheckpointView, EvidenceTarget } from '../../shared/runtime/context.js';

const require = createRequire(import.meta.url);
const { createCheckpointService } = require('../../bridge/runtime/threads/checkpointService.js') as {
  createCheckpointService(): { create(input: Record<string, unknown>): ContextCheckpointView };
};
const { createHandoffService } = require('../../bridge/runtime/threads/handoffService.js') as {
  createHandoffService(options: Record<string, unknown>): RuntimeHandoffPort;
};

const ENV = '11111111-1111-4111-8111-111111111111';
const H_A = '22222222-2222-4222-8222-222222222222';
const H_B = '33333333-3333-4333-8333-333333333333';
const H_C = '44444444-4444-4444-8444-444444444444';
const REPO = Object.freeze({
  environmentId: ENV,
  canonicalCommonDir: '/repo',
  pathPolicy: Object.freeze({ platform: 'posix', volumeId: 'vol', caseSensitive: true }),
}) as RepoRef;
const session = (harness: string, id: string): SessionRef =>
  Object.freeze({ environmentId: ENV, harnessInstanceId: harness, nativeSessionId: id }) as SessionRef;
const S_A = session(H_A, 'session-a');
const S_B = session(H_B, 'session-b');
const S_B_SAME_ID = session(H_C, 'session-b');
const ENTRIES = Object.freeze([
  { class: 'goal', origin: { kind: 'host', commandId: 'cmd-1' }, text: 'goal' },
]);

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface World {
  threads: ThreadService;
  handoffs: RuntimeHandoffPort;
  thread: ThreadRecord;
  owner: string;
  joined: string;
  state: RuntimeThreadState;
}

async function buildWorld(): Promise<World> {
  const sessions = new Map<string, SessionRef>([
    [S_A.nativeSessionId, S_A],
    [S_B.nativeSessionId, S_B],
  ]);
  const resolveSession: ThreadSessionSource = async (ref) =>
    sessions.has(ref.nativeSessionId) ? { session: ref, archived: false, parentSession: null } : null;
  const threads = createThreadService({ resolveSession });
  const checkpoints = createCheckpointService();
  const handoffs = createHandoffService({
    threads,
    checkpoints,
    openTarget: async ({ target }: { target: { session: SessionRef } }) => ({ nativeSessionId: target.session.nativeSessionId }),
    sendPrompt: async () => ({ ackId: 'ack-1' }),
  });
  const timeline = createTurnTimeline();
  const thread = await threads.bind({ session: S_A, repo: REPO });
  const joined = await threads.join({ threadId: thread.threadId, session: S_B, repo: REPO });
  const state = createRuntimeThreadState({ thread: threads, handoff: handoffs, timeline });
  return {
    threads,
    handoffs,
    thread,
    owner: threads.get(thread.threadId).participants[0]!.participantId,
    joined: joined.participantId,
    state,
  };
}

/* -------------------------------------------------- finding 3: close invalidates in-flight work */

describe('close invalidates in-flight thread operations', () => {
  it('a join that lands after close does not write the closed thread back into the UI', async () => {
    const world = await buildWorld();
    const realJoin = world.threads.join.bind(world.threads);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    world.threads.join = async (input) => {
      const result = realJoin(input);
      await held;
      return result;
    };

    await world.state.openThread({ session: S_A, repo: REPO });
    const joining = world.state.joinThread(S_B);
    await tick();
    world.state.closeThread();
    release();
    await joining;
    await tick();

    expect(world.state.summary.value).toBeNull();
    expect(world.state.threadId.value).toBeNull();
  });

  it('an open that lands after close does not re-open the view', async () => {
    const world = await buildWorld();
    const realBind = world.threads.bind.bind(world.threads);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    world.threads.bind = async (input) => {
      const result = realBind(input);
      await held;
      return result;
    };

    const opening = world.state.openThread({ session: S_A, repo: REPO });
    await tick();
    world.state.closeThread();
    release();
    await opening;
    await tick();

    expect(world.state.summary.value).toBeNull();
    expect(world.state.threadId.value).toBeNull();
  });
});

/* -------------------------------------------------- finding 4: reopen restores an unfinished handoff */

describe('reopening a thread restores its unfinished handoff', () => {
  it('a prepared handoff survives close and reopen and is not duplicated', async () => {
    const world = await buildWorld();
    await world.state.openThread({ session: S_A, repo: REPO });
    await world.state.beginHandoff({
      sourceParticipantId: world.owner,
      targetParticipantId: world.joined,
      prompt: 'go',
      entries: ENTRIES,
    });
    await world.state.prepareHandoff('go');
    const before = world.state.handoff.value;
    expect(before?.state).toBe('prepared');

    world.state.closeThread();
    expect(world.state.handoff.value).toBeNull();

    await world.state.openThread({ session: S_A, repo: REPO });
    const after = world.state.handoff.value;
    expect(after).not.toBeNull();
    expect(after?.handoffId).toBe(before?.handoffId);
    expect(after?.state).toBe('prepared');
    expect(world.handoffs.handoffs()).toHaveLength(1);
  });
});

/* -------------------------------------------------- finding 5: a cancelled handoff blocks the next begin */

describe('a resolved handoff does not block the next begin', () => {
  it('a cancelled handoff leaves the thread able to start a new one', async () => {
    const world = await buildWorld();
    await world.state.openThread({ session: S_A, repo: REPO });
    await world.state.beginHandoff({
      sourceParticipantId: world.owner,
      targetParticipantId: world.joined,
      prompt: 'go',
      entries: ENTRIES,
    });
    await world.state.cancelHandoff('user cancelled');
    expect(world.state.handoff.value?.state).toBe('cancelled');

    world.state.error.value = '';
    await world.state.beginHandoff({
      sourceParticipantId: world.owner,
      targetParticipantId: world.joined,
      prompt: 'go',
      entries: ENTRIES,
    });

    expect(world.state.error.value).toBe('');
    expect(world.state.handoff.value?.state).toBe('attached');
    expect(world.state.handoff.value?.handoffId).not.toBe(world.handoffs.handoffs()[0]?.handoffId);
  });

  it('a completed handoff also allows the reverse direction', async () => {
    const world = await buildWorld();
    await world.state.openThread({ session: S_A, repo: REPO });
    await world.state.beginHandoff({
      sourceParticipantId: world.owner,
      targetParticipantId: world.joined,
      prompt: 'go',
      entries: ENTRIES,
    });
    await world.state.prepareHandoff('go');
    await world.state.deliverHandoff();
    await world.state.observeHandoff('ev-1');
    expect(world.state.handoff.value?.state).toBe('active');

    world.state.error.value = '';
    await world.state.beginHandoff({
      sourceParticipantId: world.joined,
      targetParticipantId: world.owner,
      prompt: 'go back',
      entries: ENTRIES,
    });

    expect(world.state.error.value).toBe('');
    expect(world.state.handoff.value?.state).toBe('attached');
  });

  it('an UNFINISHED handoff still blocks a second begin', async () => {
    const world = await buildWorld();
    await world.state.openThread({ session: S_A, repo: REPO });
    await world.state.beginHandoff({
      sourceParticipantId: world.owner,
      targetParticipantId: world.joined,
      prompt: 'go',
      entries: ENTRIES,
    });
    world.state.error.value = '';
    await world.state.beginHandoff({
      sourceParticipantId: world.owner,
      targetParticipantId: world.joined,
      prompt: 'go',
      entries: ENTRIES,
    });

    expect(world.handoffs.handoffs()).toHaveLength(1);
    expect(world.state.handoff.value?.handoffId).toBe(world.handoffs.handoffs()[0]?.handoffId);
  });
});

/* -------------------------------------------------- finding 6: the session index is per participant */

describe('the session index resolves each participant by its own session', () => {
  it('opening from a JOINED session resolves that participant, and the owner stays indexed', async () => {
    const world = await buildWorld();
    world.state.closeThread();
    await world.state.openThread({ session: S_B, repo: REPO });

    const opened = world.state.threadForSession(S_B);
    expect(opened).not.toBeNull();
    expect(opened?.participantId).toBe(world.joined);
    expect(opened?.threadId).toBe(world.thread.threadId);

    const owner = world.state.threadForSession(S_A);
    expect(owner).not.toBeNull();
    expect(owner?.participantId).toBe(world.owner);
  });

  it('joining a third session indexes it by its own participant', async () => {
    const world = await buildWorld();
    await world.state.openThread({ session: S_A, repo: REPO });
    await world.state.joinThread(S_B);

    const joined = world.state.threadForSession(S_B);
    expect(joined?.participantId).toBe(world.joined);
    expect(joined?.threadId).toBe(world.thread.threadId);
    expect(world.state.threadForSession(S_A)?.participantId).toBe(world.owner);
  });
});

/* -------------------------------------------------- finding 7: the picker dedups by full identity */

describe('participant picker identity', () => {
  it('a session that only shares a nativeSessionId with a joined participant is still offered', async () => {
    const module = await import('../components/runtime/ParticipantPicker.vue');
    const Picker = module.default;
    const participants = [
      Object.freeze({
        participantId: '55555555-5555-4555-8555-555555555555',
        role: 'owner' as const,
        state: 'active' as const,
        session: S_A,
        nativeParent: null,
        harnessInstanceId: H_A,
      }),
      Object.freeze({
        participantId: '66666666-6666-4666-8666-666666666666',
        role: 'participant' as const,
        state: 'active' as const,
        session: S_B,
        nativeParent: null,
        harnessInstanceId: H_B,
      }),
    ];
    const app = createApp(defineComponent({
      setup() {
        return () => h(Picker as never, {
          participants,
          targets: [],
          activeParticipantId: participants[0]!.participantId,
          availableSessions: [Object.freeze({ session: S_B_SAME_ID, label: 'dsh', harness: H_C })],
          harnessLabels: Object.freeze({ [H_A]: 'opencode', [H_B]: 'codex', [H_C]: 'dsh' }),
          busy: false,
          onJoin: () => {},
        } as never);
      },
    }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    app.mount(host);
    await nextTick();

    const buttons = [...host.querySelectorAll('button[data-testid="add-source"]')];
    expect(buttons).toHaveLength(1);
    // A different harnessInstanceId with the SAME nativeSessionId is a DIFFERENT session.
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((buttons[0] as HTMLButtonElement).getAttribute('data-native-session-id')).toBe('session-b');

    app.unmount();
    host.remove();
  });

  it('the very same SessionRef is recognised as already joined', async () => {
    const module = await import('../components/runtime/ParticipantPicker.vue');
    const Picker = module.default;
    const participants = [
      Object.freeze({
        participantId: '55555555-5555-4555-8555-555555555555',
        role: 'owner' as const,
        state: 'active' as const,
        session: S_A,
        nativeParent: null,
        harnessInstanceId: H_A,
      }),
      Object.freeze({
        participantId: '66666666-6666-4666-8666-666666666666',
        role: 'participant' as const,
        state: 'active' as const,
        session: S_B,
        nativeParent: null,
        harnessInstanceId: H_B,
      }),
    ];
    const app = createApp(defineComponent({
      setup() {
        return () => h(Picker as never, {
          participants,
          targets: [],
          activeParticipantId: participants[0]!.participantId,
          availableSessions: [Object.freeze({ session: S_B, label: 'codex', harness: H_B })],
          harnessLabels: Object.freeze({ [H_A]: 'opencode', [H_B]: 'codex', [H_C]: 'dsh' }),
          busy: false,
          onJoin: () => {},
        } as never);
      },
    }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    app.mount(host);
    await nextTick();

    const buttons = [...host.querySelectorAll('button[data-testid="add-source"]')];
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);

    app.unmount();
    host.remove();
  });
});

/* -------------------------------------------------- finding 8: the evidence cache is scoped */

describe('evidence cache invalidation', () => {
  it('switching the checkpoint clears the previously read page', async () => {
    const module = await import('../components/runtime/ContextEvidenceView.vue');
    const View = module.default;
    const scope = { threadId: '99999999-9999-4999-8999-999999999999', environmentId: ENV };
    const payloads = ['AAAA payload for checkpoint one', 'BBBB payload for checkpoint two'];
    const service = createCheckpointService();
    const built = payloads.map((payload, index) => service.create({
      checkpointId: index === 0 ? '77777777-7777-4777-8777-777777777777' : '88888888-8888-4888-8888-888888888888',
      scope,
      at: 1,
      entries: [{
        class: 'diff',
        origin: { kind: 'file', path: `src/f${index}.ts` },
        evidence: { hash: evidenceHash(payload), bytes: new TextEncoder().encode(payload).byteLength, target: { repoKey: 'repo:/repo', revision: String(index + 1) } },
      }],
    }) as ContextCheckpointView);
    const checkpointA = built[0]!;
    const checkpointB = built[1]!;
    const refA = checkpointA.evidence[0]!;
    const refB = checkpointB.evidence[0]!;
    const readEvidence = (input: { hash: string }): { bytes: Uint8Array; totalBytes: number } => {
      const index = [refA.hash, refB.hash].indexOf(input.hash);
      if (index < 0) throw new Error(`unknown hash ${input.hash}`);
      const bytes = new TextEncoder().encode(payloads[index]!);
      return { bytes, totalBytes: bytes.byteLength };
    };

    const checkpoint = ref(checkpointA);
    const currentTarget = ref<EvidenceTarget>(Object.freeze({ repoKey: 'repo:/repo', revision: '1' }));
    const app = createApp(defineComponent({
      setup() {
        return () => h(View as never, {
          checkpoint: checkpoint.value,
          currentTarget: currentTarget.value,
          readEvidence,
          pageLength: 4096,
        } as never);
      },
    }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    app.mount(host);
    await nextTick();
    await tick();

    const readButtons = () => [...host.querySelectorAll('button[data-testid="read-evidence-page"]')] as HTMLButtonElement[];
    expect(readButtons()).toHaveLength(1);
    readButtons()[0]!.click();
    await nextTick();
    await tick();
    const pageText = host.querySelector('[data-testid="evidence-page-text"]')?.textContent;
    const pageError = host.querySelector('[data-testid="evidence-error"]')?.textContent;
    expect(`${String(pageText)}|${String(pageError)}`).toContain('AAAA');

    checkpoint.value = checkpointB;
    currentTarget.value = Object.freeze({ repoKey: 'repo:/repo', revision: '2' });
    await nextTick();
    await tick();

    expect(host.querySelector('[data-testid="evidence-page-text"]')).toBeNull();

    app.unmount();
    host.remove();
  });
});
