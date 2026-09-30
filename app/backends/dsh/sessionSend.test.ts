import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import {
  abortDshSend,
  buildDshPromptRequest,
  padDshPendingSend,
  runDshSend,
  type DshSendApi,
} from './sessionSend';
import type {
  BackendMessageSendParams,
  RequestGuard,
  SendPreflight,
} from '../../composables/backendMessageSend.types';
import type { DshClientRequest } from './types';
import { createBackendRequestFence } from '../../utils/backendRequestFence';

// ---------------------------------------------------------------------------
// Fixtures. The live smoke (`.omo/evidence/dsh-web-adapt/task-25/cli-smoke-results.json`,
// dsh@0.2.0-rc.2 on 127.0.0.1:3080) is the source of truth: `session/prompt`
// args are `{request:{requestId,sessionId,mode,content,clientTimeZone?}}` (the
// `request:` wrapper is mandatory — flat args answer gateway/arguments-invalid),
// the outer rpcId must equal the inner requestId, and `session/cancel` takes
// `{request:{sessionId}}` (Todo 21's abortSession seam).
// ---------------------------------------------------------------------------

const SESSION = 'session-1';

function createParams(
  overrides: Partial<BackendMessageSendParams> = {},
): BackendMessageSendParams {
  return {
    activeDirectory: ref('/repo'),
    ...overrides,
  } as unknown as BackendMessageSendParams;
}

function createPreflight(overrides: Partial<SendPreflight> = {}): SendPreflight {
  return {
    backend: 'dsh',
    sessionId: SESSION,
    text: 'hello dsh',
    transformedText: 'hello dsh',
    hasText: true,
    attachments: [],
    selectedModel: 'deepseek-official/deepseek-flash',
    selectedMode: 'build',
    selectedThinking: undefined,
    modelProvider: undefined,
    modelId: undefined,
    codexDirectory: '',
    slash: null,
    commandMatch: null,
    transformText: (value: string) => value,
    ...overrides,
  };
}

function currentGuard(): RequestGuard {
  return { isCurrent: () => true };
}

type DshSendApiFake = DshSendApi & {
  prompt: ReturnType<typeof vi.fn>;
  abortSession: ReturnType<typeof vi.fn>;
  sessionIdForCwd?: ReturnType<typeof vi.fn>;
  isServerTerminal?: () => boolean;
  isBlankSession?: ReturnType<typeof vi.fn>;
};

function createApi(): DshSendApiFake {
  return {
    prompt: vi.fn().mockResolvedValue({ accepted: true }),
    abortSession: vi.fn().mockResolvedValue(undefined),
  };
}

function emittedRequest(api: DshSendApiFake): DshClientRequest {
  const call = api.prompt.mock.calls[0];
  expect(call).toBeDefined();
  return call![0] as DshClientRequest;
}

/** The inner `session/prompt` request record (inside the mandatory wrapper). */
function emittedInner(api: DshSendApiFake): Record<string, unknown> {
  const args = emittedRequest(api).payload.args as { request: Record<string, unknown> };
  expect(Object.keys(args)).toEqual(['request']);
  return args.request;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// RACE (a): send vs server-terminal — the send lands as the follow stream dies.
// The final state must be coherent: NEVER a phantom "sent" success.
// ---------------------------------------------------------------------------

describe('race: send vs server-terminal', () => {
  it('never sends when the server stream is already terminal', async () => {
    const api = createApi();
    api.isServerTerminal = () => true;

    const result = await runDshSend(createParams(), createPreflight(), currentGuard(), api);

    expect(api.prompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'server-terminal', phase: 'before-send' });
  });

  it('does not report a phantom sent success when the stream terminates as the ack lands', async () => {
    const api = createApi();
    let terminal = false;
    api.isServerTerminal = () => terminal;
    const ack = deferred<{ accepted: true }>();
    api.prompt.mockReturnValue(ack.promise);

    const sending = runDshSend(createParams(), createPreflight(), currentGuard(), api);
    await vi.waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(1));
    terminal = true; // the follow stream dies while the ack is in flight
    ack.resolve({ accepted: true });
    const result = await sending;

    expect(api.prompt).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'server-terminal', phase: 'after-ack' });
  });

  it('accepts a normally delivered prompt while the stream stays live', async () => {
    const api = createApi();
    const result = await runDshSend(
      createParams(),
      createPreflight(),
      currentGuard(),
      api,
      { newRequestId: () => 'req-1' },
    );

    expect(result).toEqual({ kind: 'accepted', requestId: 'req-1', sessionId: SESSION });
  });
});

// ---------------------------------------------------------------------------
// RACE (b): turn-cancel vs send in flight — cancel must produce a TERMINAL
// state sync through Todo 21's abortSession, never a stuck "sending" and never
// a phantom "sent".
// ---------------------------------------------------------------------------

describe('race: turn-cancel vs send in flight', () => {
  it('aborts the session through the Todo 21 seam and reports a terminal result', async () => {
    const api = createApi();

    const result = await abortDshSend({ api, sessionId: SESSION });

    expect(api.abortSession).toHaveBeenCalledWith(SESSION);
    expect(result).toEqual({ kind: 'aborted', sessionId: SESSION });
  });

  it('drops the in-flight send acceptance after the turn cancel invalidated the fence', async () => {
    const fence = createBackendRequestFence(() => 'dsh');
    const token = fence.start();
    const guard: RequestGuard = { isCurrent: () => fence.isCurrent(token) };
    const api = createApi();
    const ack = deferred<{ accepted: true }>();
    api.prompt.mockReturnValue(ack.promise);

    const sending = runDshSend(createParams(), createPreflight(), guard, api);
    await vi.waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(1));

    // The user hits stop while the prompt REST call is still in flight: the
    // cancel goes out through abortSession and the fence is invalidated.
    const aborted = await abortDshSend({ api, sessionId: SESSION });
    fence.invalidate();
    ack.resolve({ accepted: true });
    const result = await sending;

    expect(aborted).toEqual({ kind: 'aborted', sessionId: SESSION });
    expect(api.abortSession).toHaveBeenCalledWith(SESSION);
    expect(result).toEqual({ kind: 'stale' });
  });

  it('drops a cancel whose fence already moved instead of aborting a foreign turn', async () => {
    const fence = createBackendRequestFence(() => 'dsh');
    const token = fence.start();
    const guard: RequestGuard = { isCurrent: () => fence.isCurrent(token) };
    fence.invalidate();
    const api = createApi();

    const result = await abortDshSend({ api, sessionId: SESSION, guard });

    expect(result).toEqual({ kind: 'stale' });
    expect(api.abortSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RACE (c): cwd difference — a worktree path is passed, so the send's cwd must
// be the selected worktree, not the session's original cwd.
// ---------------------------------------------------------------------------

describe('race: worktree cwd vs the session original cwd', () => {
  it('sends into the session resolved for the selected worktree', async () => {
    const api = createApi();
    api.sessionIdForCwd = vi.fn(async (cwd: string) => (cwd === '/repo/wt-a' ? 'session-wt-a' : null));

    const result = await runDshSend(
      createParams({ activeDirectory: ref('/repo/wt-a') }),
      createPreflight(),
      currentGuard(),
      api,
      { newRequestId: () => 'req-wt' },
    );

    expect(api.sessionIdForCwd).toHaveBeenCalledWith('/repo/wt-a');
    expect(api.prompt).toHaveBeenCalledTimes(1);
    expect(emittedInner(api).sessionId).toBe('session-wt-a');
    expect(result).toEqual({ kind: 'accepted', requestId: 'req-wt', sessionId: 'session-wt-a' });
  });

  it('does not send or create a session when the selected worktree has none', async () => {
    const api = createApi();
    api.sessionIdForCwd = vi.fn().mockResolvedValue(null);

    const result = await runDshSend(
      createParams({ activeDirectory: ref('/repo/wt-a') }),
      createPreflight(),
      currentGuard(),
      api,
    );

    expect(api.prompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'pending' });
  });

  it('stays stale when the fence moves while the worktree session is resolved', async () => {
    const fence = createBackendRequestFence(() => 'dsh');
    const token = fence.start();
    const guard: RequestGuard = { isCurrent: () => fence.isCurrent(token) };
    const api = createApi();
    api.sessionIdForCwd = vi.fn(async () => {
      fence.invalidate();
      return 'session-wt-a';
    });

    const result = await runDshSend(
      createParams({ activeDirectory: ref('/repo/wt-a') }),
      createPreflight(),
      guard,
      api,
    );

    expect(api.prompt).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'stale' });
  });

  it('uses the selected session when the api cannot resolve a worktree session', async () => {
    const api = createApi();

    const result = await runDshSend(
      createParams({ activeDirectory: ref('/repo/wt-a') }),
      createPreflight(),
      currentGuard(),
      api,
      { newRequestId: () => 'req-plain' },
    );

    expect(emittedInner(api).sessionId).toBe(SESSION);
    expect(result).toEqual({ kind: 'accepted', requestId: 'req-plain', sessionId: SESSION });
  });

  it('uses the selected session when no worktree cwd is active', async () => {
    const api = createApi();
    api.sessionIdForCwd = vi.fn().mockResolvedValue('never-used');

    const result = await runDshSend(
      createParams({ activeDirectory: ref('') }),
      createPreflight(),
      currentGuard(),
      api,
      { newRequestId: () => 'req-nocwd' },
    );

    expect(api.sessionIdForCwd).not.toHaveBeenCalled();
    expect(emittedInner(api).sessionId).toBe(SESSION);
    expect(result).toEqual({ kind: 'accepted', requestId: 'req-nocwd', sessionId: SESSION });
  });
});

// ---------------------------------------------------------------------------
// No available session: the pending text is PADDED with an empty identity.
// No session is created and nothing is sent.
// ---------------------------------------------------------------------------

describe('no available session', () => {
  it('pads the pending text with empty projectID/sessionID/agent/inbox without creating or sending', async () => {
    const api = createApi();

    const result = await runDshSend(
      createParams(),
      createPreflight({ sessionId: '   ' }),
      currentGuard(),
      api,
    );

    expect(api.prompt).not.toHaveBeenCalled();
    expect(api.abortSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'pending',
      record: { text: 'hello dsh', projectID: '', sessionID: '', agent: '', inbox: [] },
    });
  });

  it('padDshPendingSend pads every identity field empty and keeps the text', () => {
    expect(padDshPendingSend('draft text')).toEqual({
      text: 'draft text',
      projectID: '',
      sessionID: '',
      agent: '',
      inbox: [],
    });
  });
});

// ---------------------------------------------------------------------------
// First user message: model.presetName is written as an EXPLICIT empty string
// (the key is present, never omitted).
// ---------------------------------------------------------------------------

describe('first user message model.presetName', () => {
  it('writes model.presetName as an explicit empty string on the first user message', async () => {
    const api = createApi();

    await runDshSend(createParams(), createPreflight(), currentGuard(), api, {
      firstUserMessage: true,
      newRequestId: () => 'req-first',
    });

    const model = emittedInner(api).model as Record<string, unknown>;
    expect(model).toBeDefined();
    expect(Object.hasOwn(model, 'presetName')).toBe(true);
    expect(model.presetName).toBe('');
    expect(model.provider).toBe('');
  });

  it('omits the model key entirely on follow-up messages', async () => {
    const api = createApi();

    await runDshSend(createParams(), createPreflight(), currentGuard(), api, {
      firstUserMessage: false,
      newRequestId: () => 'req-next',
    });

    expect(Object.hasOwn(emittedInner(api), 'model')).toBe(false);
  });

  it('asks the api whether the session is blank when the caller does not decide', async () => {
    const api = createApi();
    api.isBlankSession = vi.fn().mockResolvedValue(true);

    await runDshSend(createParams(), createPreflight(), currentGuard(), api, {
      newRequestId: () => 'req-blank',
    });

    expect(api.isBlankSession).toHaveBeenCalledWith(SESSION);
    expect((emittedInner(api).model as Record<string, unknown>).presetName).toBe('');
  });

  it('omits the model key when the api reports a non-blank session', async () => {
    const api = createApi();
    api.isBlankSession = vi.fn().mockResolvedValue(false);

    await runDshSend(createParams(), createPreflight(), currentGuard(), api, {
      newRequestId: () => 'req-notblank',
    });

    expect(Object.hasOwn(emittedInner(api), 'model')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wire shape: the 0.2.0-rc.2 request wrapper and the requestId -> rpcId
// binding (Todo 20), plus delivery mode and timezone passthrough.
// ---------------------------------------------------------------------------

describe('session/prompt wire shape', () => {
  it('wraps the args under request and keeps the outer rpcId equal to the requestId', async () => {
    const api = createApi();

    await runDshSend(createParams(), createPreflight(), currentGuard(), api, {
      newRequestId: () => 'req-bind',
    });

    const request = emittedRequest(api);
    expect(request.type).toBe('client-request');
    expect(request.method).toBe('session/prompt');
    expect(request.rpcId).toBe('req-bind');
    expect(Object.keys(request.payload.args)).toEqual(['request']);
    const inner = emittedInner(api);
    expect(inner.requestId).toBe('req-bind');
    expect(inner.sessionId).toBe(SESSION);
    expect(inner.mode).toBe('queue');
    expect(inner.content).toEqual([{ type: 'text', text: 'hello dsh' }]);
  });

  it('buildDshPromptRequest reuses the Todo 20 requestId for both the inner and outer id', () => {
    const plan = buildDshPromptRequest({
      sessionId: SESSION,
      content: [{ type: 'text', text: 'hi' }],
      newRequestId: () => 'req-pure',
    });

    expect(plan.requestId).toBe('req-pure');
    expect(plan.request.rpcId).toBe('req-pure');
    expect(plan.send.request.rpcId).toBe('req-pure');
    expect(plan.send.request.payload.args.requestId).toBe('req-pure');
    expect(plan.request.payload.args).toEqual({
      request: { requestId: 'req-pure', sessionId: SESSION, mode: 'queue', content: [{ type: 'text', text: 'hi' }] },
    });
  });

  it('passes the steer delivery mode through 1:1', async () => {
    const api = createApi();

    await runDshSend(createParams(), createPreflight(), currentGuard(), api, {
      mode: 'steer',
      newRequestId: () => 'req-steer',
    });

    expect(emittedInner(api).mode).toBe('steer');
  });

  it('omits clientTimeZone unless one is supplied and carries it verbatim otherwise', async () => {
    const withoutZone = createApi();
    await runDshSend(createParams(), createPreflight(), currentGuard(), withoutZone, {
      newRequestId: () => 'req-z1',
    });
    expect(emittedInner(withoutZone).clientTimeZone).toBeUndefined();

    const withZone = createApi();
    await runDshSend(createParams(), createPreflight(), currentGuard(), withZone, {
      clientTimeZone: 'Asia/Shanghai',
      newRequestId: () => 'req-z2',
    });
    expect(emittedInner(withZone).clientTimeZone).toBe('Asia/Shanghai');
  });

  it('propagates a prompt failure so the composer can restore the text', async () => {
    const api = createApi();
    api.prompt.mockRejectedValueOnce(new Error('gateway/input-invalid'));

    await expect(
      runDshSend(createParams(), createPreflight(), currentGuard(), api, {
        newRequestId: () => 'req-fail',
      }),
    ).rejects.toThrow('gateway/input-invalid');
  });

  it('stays stale when the fence moved before dispatch', async () => {
    const api = createApi();
    const guard: RequestGuard = { isCurrent: () => false };

    const result = await runDshSend(createParams(), createPreflight(), guard, api);

    expect(result).toEqual({ kind: 'stale' });
    expect(api.prompt).not.toHaveBeenCalled();
  });
});
