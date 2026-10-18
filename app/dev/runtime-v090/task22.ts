// Task 22 registered QA browser entry — qualified session actions, sends and interactions.
//
// Loaded by scripts/qa/runtime-v090-cases/task-22.mjs from a runner-served page
// (served by the task-22 runner so no shared page route is edited). The REAL
// production modules execute in a real headless Chromium: the real
// useRuntimeMessageSend / useRuntimeSessionActions / useRuntimeInteractions
// composables over the REAL runtime client + connection and the REAL
// selectionScope. The only controlled boundary is the runtime WebSocket wire
// (ActionWire): a fixture at the transport seam that serves the bridge's
// canonical multi-target set and can hold/settle mutations, reduce a target's
// advertised capabilities and detach/reattach a target so every registered
// scenario has a deterministic numeric observable or an explicit rejection code.
//
// The page deliberately drives the NEW composables directly (the same way the
// task-21 cases drive the new session-tree tree). The legacy useBackend* seam is
// additive and INACTIVE until task 24 supplies a RuntimeSessionRuntime binding in
// App.vue, so this case makes NO end-to-end legacy-UI migration claim.
import { createRuntimeConnection } from '../../runtime/connection';
import type { RuntimeSocket } from '../../runtime/connection';
import { createRuntimeClient } from '../../runtime/client';
import { createSelectionScope } from '../../runtime/selectionScope';
import { useRuntimeMessageSend } from '../../composables/useRuntimeMessageSend';
import { useRuntimeSessionActions } from '../../composables/useRuntimeSessionActions';
import { useRuntimeInteractions } from '../../composables/useRuntimeInteractions';
import { encodeFrame, decodeFrame } from '../../../shared/runtime/protocol.js';
import { parseCapabilities } from '../../../shared/runtime/capabilities.js';
import { RUNTIME_WIRE_METHODS } from '../../../shared/runtime/runtimeWire.js';
import { encodeSessionKey, parseConnectionProfileId, parseEnvironmentId, parseHarnessInstanceId, parseInstanceId, parseSessionRef } from '../../../shared/runtime/identity.js';
import type { EnvironmentId, SessionRef } from '../../../shared/runtime/identity.js';

type AnyRecord = Record<string, any>;
type Outcome = Readonly<{ ok: boolean; value: unknown; code: string | null; field: string | null }>;

const MGMT = parseEnvironmentId('00000001-0000-4000-8000-000000000001');
const ENV_CODEX = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const ENV_ACP = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const ENV_DSH = parseEnvironmentId('33333333-3333-4333-8333-333333333333');
const ENV_UNSUPPORTED = parseEnvironmentId('44444444-4444-4444-8444-444444444444');
const ENV_GHOST = parseEnvironmentId('55555555-5555-4555-8555-555555555555');
const PROFILE = parseConnectionProfileId('99999999-9999-4999-8999-999999999999');
const FOREIGN_PROFILE = parseConnectionProfileId('88888888-8888-4888-8888-888888888888');
const INSTANCE = parseInstanceId('66666666-6666-4666-8666-666666666666');

const SESSIONS: Readonly<Record<string, SessionRef>> = Object.freeze({
  // codex and acp deliberately expose the SAME native session id under two
  // different environments/harnesses: the exact collision task 22 exists to
  // prevent from crossing.
  codex: parseSessionRef({ environmentId: ENV_CODEX, harnessInstanceId: parseHarnessInstanceId('10000000-0000-4000-8000-000000000001'), nativeSessionId: 'shared-native-id' }),
  acp: parseSessionRef({ environmentId: ENV_ACP, harnessInstanceId: parseHarnessInstanceId('10000000-0000-4000-8000-000000000002'), nativeSessionId: 'shared-native-id' }),
  dsh: parseSessionRef({ environmentId: ENV_DSH, harnessInstanceId: parseHarnessInstanceId('10000000-0000-4000-8000-000000000003'), nativeSessionId: 'dsh-native' }),
  unsupported: parseSessionRef({ environmentId: ENV_UNSUPPORTED, harnessInstanceId: parseHarnessInstanceId('10000000-0000-4000-8000-000000000004'), nativeSessionId: 'unsup-native' }),
  ghost: parseSessionRef({ environmentId: ENV_GHOST, harnessInstanceId: parseHarnessInstanceId('10000000-0000-4000-8000-000000000005'), nativeSessionId: 'ghost-native' }),
});
const ENVS: Readonly<Record<string, EnvironmentId>> = Object.freeze({ codex: ENV_CODEX, acp: ENV_ACP, dsh: ENV_DSH, unsupported: ENV_UNSUPPORTED, ghost: ENV_GHOST });

const MUTATIONS = Object.freeze(['session.send', 'session.cancel', 'interaction.respond']);
const FULL_METHODS = Object.keys(RUNTIME_WIRE_METHODS);
const CAPABILITIES = parseCapabilities({ methods: FULL_METHODS, extensions: [] });

function capsFor(target: EnvironmentId) {
  return parseCapabilities({
    methods: target === ENV_UNSUPPORTED ? FULL_METHODS.filter((method) => !MUTATIONS.includes(method)) : FULL_METHODS,
    extensions: [],
  });
}
function grantFor(target: EnvironmentId) {
  return { target, role: 'execution', capabilities: capsFor(target), permissions: [], workspaceKeys: [] };
}

type ActionRequest = Readonly<{
  id: string; method: string; target: string; epoch: string; generation: number;
  harnessInstanceId: string | null; environmentId: string | null; nativeSessionId: string | null;
  command: string | null; queue: boolean; text: string | null; idempotencyKey: string | null;
}>;

// Controlled runtime WebSocket wire. Structurally a RuntimeSocket so the real
// client/connection codecs run unchanged; only the server side is a fixture.
class ActionWire extends EventTarget {
  binaryType: BinaryType = 'arraybuffer';
  readyState = 1;
  bufferedAmount = 0;
  readonly framesById = new Map<string, AnyRecord>();
  readonly calls: ActionRequest[] = [];
  readonly byMethod = new Map<string, number>();
  readonly byMethodTarget = new Map<string, number>();
  readonly answered = new Map<string, number>();
  readonly holdMethods = new Set<string>();
  readonly held: string[] = [];
  seq = 0;

  close() { this.readyState = 3; }

  frame(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(value) })); }

  reply(request: AnyRecord, result: unknown) {
    this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: true, phase: 'read', result });
  }

  send(value: string | Uint8Array) {
    if (typeof value !== 'string') throw new TypeError('unexpected binary request');
    const request = decodeFrame(value) as AnyRecord;
    if (request.kind !== 'request') throw new TypeError('unexpected frame');
    this.calls.push(this.record(request));
    this.byMethod.set(request.method, (this.byMethod.get(request.method) ?? 0) + 1);
    const key = `${request.method}@${request.target}`;
    this.byMethodTarget.set(key, (this.byMethodTarget.get(key) ?? 0) + 1);
    this.framesById.set(request.id, request);
    if (this.holdMethods.has(request.method)) { this.held.push(request.id); return; }
    this.respond(request);
  }

  record(request: AnyRecord): ActionRequest {
    const params = request.params ?? {};
    const session = params.session ?? null;
    const args = params.args ?? {};
    return {
      id: request.id, method: request.method, target: request.target, epoch: request.epoch, generation: request.generation,
      harnessInstanceId: params.harnessInstanceId ?? null,
      environmentId: session ? session.environmentId : null,
      nativeSessionId: session ? session.nativeSessionId : null,
      command: args && args.command ? args.command.name : null,
      queue: Boolean(args && args.queue === true),
      text: args && typeof args.text === 'string' ? args.text : null,
      idempotencyKey: request.idempotencyKey ?? null,
    };
  }

  respond(request: AnyRecord) {
    switch (request.method) {
      case 'runtime.inspect':
        this.reply(request, {
          role: 'local', state: 'ready', subscribers: 1, topology: [], sources: [],
          connectionProfileId: String(PROFILE),
          targets: [grantFor(ENV_CODEX), grantFor(ENV_ACP), grantFor(ENV_DSH), grantFor(ENV_UNSUPPORTED)],
          harnesses: [], transports: { direct: true, ssh: false, slurm: false },
        });
        break;
      case 'runtime.target.attach': {
        const target = request.params.target as EnvironmentId;
        this.reply(request, {
          hello: { kind: 'hello', version: 1, target, epoch: 'epoch', generation: request.generation, instanceId: INSTANCE, capabilities: capsFor(target) },
          grant: grantFor(target),
        });
        break;
      }
      case 'runtime.target.detach': this.reply(request, { detached: true }); break;
      case 'session.send': case 'session.cancel': case 'interaction.respond': this.settle(request); break;
      case 'session.get': case 'session.list': case 'session.history': this.reply(request, {}); break;
      default: throw new TypeError(`unexpected method ${request.method}`);
    }
  }

  settle(request: AnyRecord) {
    const operationId = `op-${++this.seq}`;
    const key = `${request.method}@${request.target}`;
    this.answered.set(key, (this.answered.get(key) ?? 0) + 1);
    this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: true, phase: 'durable-accepted', result: { operationId } });
    this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: true, phase: 'native-executed', result: { operationId, value: null } });
  }

  releaseHeld() {
    const ids = this.held.splice(0);
    this.holdMethods.clear();
    let released = 0;
    for (const id of ids) { const request = this.framesById.get(id); if (request) { this.respond(request); released += 1; } }
    return released;
  }

  clearHold() { this.holdMethods.clear(); }

  summary() {
    return {
      calls: this.calls.map((record) => ({ method: record.method, target: record.target, environmentId: record.environmentId, nativeSessionId: record.nativeSessionId, command: record.command, queue: record.queue, text: record.text })),
      byMethod: Object.fromEntries(this.byMethod),
      byMethodTarget: Object.fromEntries(this.byMethodTarget),
      answered: Object.fromEntries(this.answered),
      held: this.held.length,
    };
  }
}

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && event.reason.message) || event.reason)}`); });

async function boot() {
  const wire = new ActionWire();
  let resolveSocket: () => void = () => {};
  const created = new Promise<void>((resolve) => { resolveSocket = resolve; });
  const connection = createRuntimeConnection({
    reference: { url: 'ws://127.0.0.1:43223/runtime' },
    resolveAuthentication: async () => ({}),
    createWebSocket: () => { resolveSocket(); return wire as unknown as RuntimeSocket; },
  });
  const client = createRuntimeClient({ connection });
  const connecting = connection.connect();
  await created;
  wire.frame({ kind: 'hello', version: 1, target: MGMT, epoch: 'epoch', generation: 1, instanceId: INSTANCE, capabilities: CAPABILITIES });
  await connecting;
  await client.inspect();
  for (const env of [ENV_CODEX, ENV_ACP, ENV_DSH, ENV_UNSUPPORTED]) await client.attach(env);
  const selection = createSelectionScope({ client, profileId: PROFILE });
  const ctx = { client, profileId: PROFILE, capture: () => selection.capture() };
  const messages = useRuntimeMessageSend(ctx);
  const actions = useRuntimeSessionActions(ctx);
  const interactions = useRuntimeInteractions(ctx);
  return { wire, client, selection, messages, actions, interactions };
}

async function settle(mutation: unknown): Promise<Outcome> {
  const pending = mutation as AnyRecord;
  await pending.accepted.catch(() => undefined);
  try { const result = await pending.executed; return { ok: true, value: (result as AnyRecord)?.value ?? null, code: null, field: null }; }
  catch (error) { return { ok: false, value: null, code: (error as AnyRecord)?.code ?? null, field: (error as AnyRecord)?.field ?? null }; }
}

async function call(fn: () => unknown): Promise<Outcome> {
  try { return await settle(fn()); }
  catch (error) { return { ok: false, value: null, code: (error as AnyRecord)?.code ?? null, field: (error as AnyRecord)?.field ?? null }; }
}

function buildApi(state: Awaited<ReturnType<typeof boot>>) {
  const { wire, client, selection, messages, actions, interactions } = state;
  const session = (which: string): SessionRef => SESSIONS[which]!;
  const env = (which: string): EnvironmentId => ENVS[which]!;
  return {
    errors: () => errors,
    wireSummary: () => wire.summary(),
    hold: (method: string) => { wire.holdMethods.add(method); return { holding: method }; },
    release: () => ({ released: wire.releaseHeld() }),
    clearHold: () => { wire.clearHold(); return { cleared: true }; },
    select: (which: string) => {
      const capture = which === 'none' ? selection.select(null) : selection.select(session(which));
      return { selected: capture ? encodeSessionKey(capture.selection.session) : null };
    },
    detach: async (which: string) => { await client.detach(env(which)); return { detached: which }; },
    reattach: async (which: string) => { await client.attach(env(which)); return { attached: which }; },
    query: () => ({
      profile: String(PROFILE),
      attached: [ENV_CODEX, ENV_ACP, ENV_DSH, ENV_UNSUPPORTED].map(String),
      attachedCount: 4,
      codexNative: SESSIONS.codex!.nativeSessionId,
      acpNative: SESSIONS.acp!.nativeSessionId,
      distinctKeys: encodeSessionKey(SESSIONS.codex!) !== encodeSessionKey(SESSIONS.acp!),
    }),
    sendCaptured: (input: AnyRecord) => call(() => messages.sendCaptured(input)),
    send: (which: string, input: AnyRecord) => call(() => messages.send(session(which), input)),
    queue: (which: string, input: AnyRecord) => call(() => messages.queue(session(which), input)),
    slash: (which: string, name: string, args?: AnyRecord) => call(() => messages.slash(session(which), name, args)),
    attachFiles: (which: string, attachments: AnyRecord[], input?: AnyRecord) => call(() => messages.attach(session(which), attachments, input ?? {})),
    cancel: (which: string) => call(() => messages.cancelTurn(session(which))),
    fork: (which: string, payload?: AnyRecord) => call(() => actions.fork(session(which), payload ?? {})),
    rename: (which: string, title: string) => call(() => actions.rename(session(which), title)),
    archive: (which: string) => call(() => actions.archive(session(which))),
    unarchive: (which: string) => call(() => actions.unarchive(session(which))),
    remove: (which: string) => call(() => actions.delete(session(which))),
    compact: (which: string) => call(() => actions.compact(session(which))),
    revert: (which: string, payload?: AnyRecord) => call(() => actions.revert(session(which), payload ?? {})),
    todos: (which: string) => call(() => actions.todos(session(which))),
    tokenMonitor: (which: string) => call(() => actions.tokenMonitor(session(which))),
    permission: (which: string, id: string, decision: AnyRecord) => call(() => interactions.permission(session(which), id, decision)),
    question: (which: string, id: string, answers: AnyRecord) => call(() => interactions.question(session(which), id, answers)),
    track: (which: string, id: string) => { interactions.track(session(which), id); return { tracked: id }; },
    pendingFor: (which: string) => ({ ids: [...interactions.pendingFor(session(which))] }),
    setModel: (which: string, model: string) => { messages.setModel(session(which), model); return { set: model }; },
    clearModel: (which: string) => { messages.clearModel(session(which)); return { cleared: true }; },
    modelFor: (which: string) => ({ model: messages.modelFor(session(which)) }),
    foreignProfileSend: (input: AnyRecord) => {
      const scope = createSelectionScope({ client, profileId: PROFILE });
      try {
        const capture = scope.select(session('acp'));
        // A REAL composable instance whose context profile differs from the
        // captured selection's profile: bind() must refuse with action.profile.
        const foreign = useRuntimeMessageSend({ client, profileId: FOREIGN_PROFILE, capture: () => capture });
        try { const mutation = foreign.sendCaptured(input); return { started: true, hasAccepted: Boolean(mutation.accepted) }; }
        catch (error) { return { started: false, code: (error as AnyRecord)?.code ?? null, field: (error as AnyRecord)?.field ?? null }; }
      } finally { scope.dispose(); }
    },
    bindMismatch: () => {
      const scope = createSelectionScope({ client, profileId: PROFILE });
      try {
        const capture = scope.select(session('acp'));
        // Captured selection belongs to acp while the bound session is codex:
        // the qualified target guard must refuse with action.session_target.
        try { messages.router.bind(session('codex'), capture); return { bound: true, code: null, field: null }; }
        catch (error) { return { bound: false, code: (error as AnyRecord)?.code ?? null, field: (error as AnyRecord)?.field ?? null }; }
      } finally { scope.dispose(); }
    },
    matrix: async () => {
      const start = wire.calls.length;
      await Promise.all([
        call(() => messages.send(session('codex'), { text: 'm' })),
        call(() => messages.cancelTurn(session('codex'))),
        call(() => actions.fork(session('codex'), { messageId: 'm' })),
        call(() => actions.rename(session('codex'), 'title')),
        call(() => actions.archive(session('codex'))),
        call(() => actions.delete(session('codex'))),
        call(() => actions.revert(session('codex'), { messageId: 'm' })),
        call(() => actions.compact(session('codex'))),
        call(() => messages.queue(session('codex'), { text: 'q' })),
        call(() => messages.slash(session('codex'), 'help')),
        call(() => interactions.permission(session('codex'), 'i', { allow: true })),
        call(() => interactions.question(session('codex'), 'i', { a: 'b' })),
        call(() => messages.attach(session('codex'), [{ name: 'f' }], {})),
        call(() => actions.todos(session('codex'))),
        call(() => actions.tokenMonitor(session('codex'))),
      ]);
      const slice = wire.calls.slice(start);
      const tally = (method: string) => slice.filter((record) => record.method === method).length;
      return {
        frameCount: slice.length,
        sessionSend: tally('session.send'),
        sessionCancel: tally('session.cancel'),
        interactionRespond: tally('interaction.respond'),
        sessionGet: tally('session.get'),
        allCodex: slice.every((record) => record.target === ENV_CODEX),
        targets: [...new Set(slice.map((record) => record.target))].map(String),
      };
    },
    status: () => ({ calls: wire.calls.length, held: wire.held.length, selected: selection.capture() !== null }),
  };
}

const statusElement = document.createElement('pre');
statusElement.id = 'qa22-status';
statusElement.style.cssText = 'white-space:pre-wrap;font:12px/1.5 monospace;padding:8px;';
document.body.appendChild(statusElement);

void (async () => {
  const state = await boot();
  const api = buildApi(state);
  (window as AnyRecord).__task22State = state;
  (window as AnyRecord).task22 = api;
  statusElement.textContent = JSON.stringify(api.status(), null, 2);
  (window as AnyRecord).__task22Ready = true;
})();
