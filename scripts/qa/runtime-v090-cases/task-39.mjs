// Task 39 registered QA case — Lead/Worker delegation, the Team tool contract and member messages.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt and parses the written result.
//
// What executes for REAL, and where:
//   * In the Node worker: the landed bridge modules bridge/runtime/collaboration/
//     delegationService.js, mailbox.js, toolServer.js and toolCapabilities.js, composed exactly
//     as the product composes them (the tool server is constructed over the delegation service,
//     which owns the mailbox unless one is injected) over the frozen shared/runtime/
//     collaboration.js + identity.js + harnessContract.js contract. Nothing is stubbed: the ONLY
//     case-owned seam is the `deliver` prompt port the service's own signature declares as an
//     injection point (delegationService.js:185), and it is backed by a counting, recording fake
//     so "the lead really delegated to a worker of a DIFFERENT harness", "the prompt the worker's
//     native session received is verbatim", "a typed source error is carried verbatim", "a plain
//     Error is classified without leaking its message" and "an unreadable outcome is never
//     retried" are OBSERVED at the sink boundary, not argued. The five tools, the role table, the
//     temporary scoped tools, the availability read model and the UI dispatch path are the
//     product's own, so the structural guarantee — a tool is callable only by the roles its frozen
//     descriptor names, and a UI-only driver never pretends to be natively callable — is driven
//     through the real code.
//   * In a real headless Chromium: the frozen shared contract — the five coordination budgets as
//     ONE frozen object, the five budget reasons, every frozen ceiling, the five harness kinds,
//     the frozen ten-entry ERROR_CODES table, the CollaborationError shape, the explicit-`at`
//     contract and the canonical native-session keys plus the id/shape parsers every rejection
//     travels through — recomputed in a second JS realm from the same pure modules. The case
//     asserts the browser values EQUAL the values the worker computes, and the worker's session
//     keys are read back from the sessionKey values the REAL addMember wrote into a real member
//     read model, so the contract the bridge enforces is provably the contract the app sees.
//
// The controlled boundaries are stated rather than papered over:
//   * the stateful services cannot cross into the browser at all — delegationService.js:1,
//     mailbox.js:1, toolServer.js:1 and toolCapabilities.js:1 each import from node:crypto — so
//     teams, members, scopes, delegate, evidence, messages, control, sweep, reconcile, the
//     temporary scoped tools and the UI dispatch path are proven in the worker only. The split is
//     exactly the posture tasks 37 and 38 disclosed for their coordinator and fan-out service.
//   * no browser shim is needed: the browser closure is shared/runtime/collaboration.js ->
//     capabilities.js + identity.js, plus shared/runtime/harnessContract.js -> identity.js +
//     capabilities.js + nativeExtensions.js, pure ESM with no node:* builtin and no bare or
//     aliased specifier (nativeExtensions.js imports nothing at all), so Vite resolves every
//     import natively.
//   * "the UI-only driver dispatches through the UI by the SAME mechanism" is satisfied by driving
//     the product's OWN tool server and capability model — callFromUi runs the SAME scope checks
//     and the SAME service operations, and the availability read model reports nativeCallable
//     false for every tool a ui-only driver holds — never by claiming a rendered component; task
//     42 owns the collaboration UI.
//
// This case does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that —
// claims no UI rendering (task 42 owns the collaboration UI), authors no PASS verdict, edits no
// product or test file, and performs no git operation. It claims no durability across a real
// process death: the mailbox snapshot/rehydrate round trip is proven IN-PROCESS over the real
// module, because the single-writer durable store is task 8's surface and is not exercised here —
// the same in-process disclosure tasks 34, 37 and 38 made. The five budgets are enforced inside
// ONE delegation service instance and are not claimed across processes or services. The deliver
// port is a deterministic double at the unit boundary: no live opencode, codex, kimi-web, dsh or
// acp backend is contacted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-39-fixture.mjs';

import { createDelegationService } from '../../../bridge/runtime/collaboration/delegationService.js';
import { createMailbox, MAILBOX_LIMITS } from '../../../bridge/runtime/collaboration/mailbox.js';
import { createToolServer } from '../../../bridge/runtime/collaboration/toolServer.js';
import { TOOL_INJECTION_MODES } from '../../../bridge/runtime/collaboration/toolCapabilities.js';
import { DELEGATION_ROLES } from '../../../bridge/runtime/collaboration/delegationService.js';
import {
  BUDGET_REASONS,
  COLLABORATION_BUDGETS,
  COLLABORATION_SCHEMA_VERSION,
  CollaborationError,
  MAX_CRITERION_CHARS,
  MAX_CRITERIA_COUNT,
  MAX_CRITERION_ID_CHARS,
  MAX_DELIVERABLE_PATHS,
  MAX_DELIVERABLES,
  MAX_MAILBOX_TEXT_CHARS,
  MAX_NAMES,
  MAX_PATH_CHARS,
  MAX_TASK_TITLE_CHARS,
  collaborationBudgetLimits,
  parseAt,
  parseCriterion,
  parseCriteria,
  parseDeliverable,
  parseMessageId,
  parseTaskId,
  parseTaskTitle,
  parseTeamId,
  parseTeamName,
} from '../../../shared/runtime/collaboration.js';
import {
  decodeSessionKey,
  encodeSessionKey,
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseSessionRef,
} from '../../../shared/runtime/identity.js';
import { HARNESS_KINDS } from '../../../shared/runtime/harnessContract.js';
import { ERROR_CODES, ProtocolError } from '../../../shared/runtime/capabilities.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const HEAP_BOUND = 256 * 1024 * 1024;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

// The five harness kinds of this plan: opencode, codex, acp, kimi-web, dsh. Each team member works
// in a DISTINCT native session, so only the concurrency budget can ever pair two of them.
//
// THE ONE SOURCE of the cross-realm identity (the twenty-sixth-instance lesson: task 39's two
// realms each hard-coded the deliverable paths AND the session identity differently, so the
// cross-realm equality could never hold). These raw strings build the worker's ENV_A/H/SESSIONS
// below AND are injected into the browser entry through evaluate, so the worker feeds addMember
// the SAME identity the browser encodes — identical by construction, not by coincidence.
const ID_ENV = '11111111-1111-4111-8111-111111111111';
const ID_HARNESS = Object.freeze({
  codex: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  acp: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  kimi: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  dsh: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  opencode: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
});
const ID_NATIVE = Object.freeze({
  codex: 'native:codex-1',
  acp: 'native:acp-1',
  kimi: 'native:kimi-1',
  dsh: 'native:dsh-1',
  opencode: 'native:opencode-1',
});
const ENV_A = parseEnvironmentId(ID_ENV);
const ENV_B = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const H = {
  codex: parseHarnessInstanceId(ID_HARNESS.codex),
  acp: parseHarnessInstanceId(ID_HARNESS.acp),
  kimi: parseHarnessInstanceId(ID_HARNESS.kimi),
  dsh: parseHarnessInstanceId(ID_HARNESS.dsh),
  opencode: parseHarnessInstanceId(ID_HARNESS.opencode),
};
const SESSIONS = {
  codex: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.codex, nativeSessionId: ID_NATIVE.codex }),
  acp: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.acp, nativeSessionId: ID_NATIVE.acp }),
  kimi: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.kimi, nativeSessionId: ID_NATIVE.kimi }),
  dsh: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.dsh, nativeSessionId: ID_NATIVE.dsh }),
  opencode: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.opencode, nativeSessionId: ID_NATIVE.opencode }),
  otherEnv: parseSessionRef({ environmentId: ENV_B, harnessInstanceId: H.acp, nativeSessionId: 'native:acp-other-env' }),
  // Team b's members live on their OWN codex native session — the SAME environment and codex harness
  // instance as team A, but a DISTINCT nativeSessionId, so the canonical key differs. The frozen
  // Session-mutation budget is per NATIVE SESSION and correctly global across teams
  // (collaboration.js:253; delegationService.js:434 counts any in-flight task on the same canonical
  // key), so if team b shared SESSIONS.codex with team A's codex worker, team b's in-flight task would
  // collide with team A's later delegate and refuse it conflict/collaboration_session_mutation for a
  // reason that has nothing to do with the scenario. A distinct session keeps F1's cross-team refusal
  // coming from the intended scope check (unauthorized/delegation_scope), not an accidental collision.
  codexTeamB: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.codex, nativeSessionId: 'native:codex-team-b' }),
};
const LEAD = '15151515-1515-4515-8515-151515151511';
const W_ACP = '15151515-1515-4515-8515-151515151512';
const W_CODEX = '15151515-1515-4515-8515-151515151513';
const W_KIMI = '15151515-1515-4515-8515-151515151514';
const W_DSH = '15151515-1515-4515-8515-151515151515';
const STRANGER = '15151515-1515-4515-8515-1515151515f0';
const UNKNOWN_PARTICIPANT = '15151515-1515-4515-8515-1515151515ff';
const OTHER_LEAD = '15151515-1515-4515-8515-151515151521';
const OTHER_WORKER = '15151515-1515-4515-8515-151515151522';
const CROSS_ENV_MEMBER = '15151515-1515-4515-8515-151515151531';
const UNKNOWN_PARENT = '15151515-1515-4515-8515-1515151515ee';
const WORKERS = {
  acp: { participantId: W_ACP, session: SESSIONS.acp },
  codex: { participantId: W_CODEX, session: SESSIONS.codex },
  'kimi-web': { participantId: W_KIMI, session: SESSIONS.kimi },
  dsh: { participantId: W_DSH, session: SESSIONS.dsh },
};

const T0 = 1700000000000;
const CRITERION = Object.freeze([{ id: 'c1', text: 'evidence attached and readable' }]);
const EVIDENCE = Object.freeze({
  deliverableId: 'evidence-bridge-review',
  artifactHash: 'f'.repeat(64),
  bytes: 4096,
  paths: Object.freeze(['bridge/runtime/collaboration/delegationService.js', 'app/runtime/delegation.test.ts']),
});
// THE ONE object every cross-realm table recomputes from, injected into the browser entry through
// evaluate's argument so the worker and the browser are identical BY CONSTRUCTION. It carries every
// case-owned input the frozen parsers and the identity encoder consume — including EVIDENCE, whose
// TWO deliverable paths task 39's realms once hard-coded differently (the exact bug this fix
// removes: the case carried two, the browser entry carried one). The worker functions read these
// same fields directly; the browser reads the very same object the case passes in. The four product
// tables' budgets / ceilings / codes are NOT here — both realms already derive those from the
// shared modules they both import, so they are identical by construction already.
const SHARED_INPUTS = Object.freeze({
  at: Object.freeze({ explicit: T0, zero: 0, fractional: 1.5 }),
  identity: Object.freeze({ environmentId: ID_ENV, harness: ID_HARNESS, native: ID_NATIVE }),
  contract: Object.freeze({
    errorShape: Object.freeze({ code: 'conflict', field: 'delegation_scope', detail: Object.freeze({ participantId: 'x' }) }),
    delegationCodes: Object.freeze(['invalid_request', 'unauthorized', 'unsupported', 'conflict', 'cancelled', 'source_unavailable', 'reconcile_required']),
  }),
  parser: Object.freeze({
    taskId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    taskIdLower: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    badTaskId: 'nope',
    teamId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
    badTeamId: 'nope',
    messageId: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
    badMessageId: 'nope',
    teamName512: 't'.repeat(512),
    teamName513: 't'.repeat(513),
    taskTitle512: 't'.repeat(512),
    taskTitle513: 't'.repeat(513),
    criteria: CRITERION,
    criteriaDuplicate: [{ id: 'c1', text: 'a' }, { id: 'c1', text: 'b' }],
    criterionA: { id: 'c1', text: 'a' },
    criterionExtra: { id: 'c1', text: 'a', extra: 1 },
    evidence: EVIDENCE,
    deliverableBadHash: { deliverableId: 'd', artifactHash: 'nope', bytes: 1, paths: ['a'] },
    deliverableEmptyPaths: { deliverableId: 'd', artifactHash: 'f'.repeat(64), bytes: 1, paths: [] },
  }),
});
const UI_LIMITATION = 'acp agents do not accept dynamic tool injection';
const FAIL_CLOSED_LIMITATION = 'driver declares no tool-injection support';

/**
 * The typed capture envelope. BOTH realms emit the SAME shape on EVERY path, success included
 * (the task-32/33 lesson): { code, field } with nulls on success. Every observed code is also
 * collected so the final check can prove every rejection code the product emitted belongs to the
 * frozen canonical ERROR_CODES table, in both realms.
 *
 * captureSync may ONLY wrap a callee that THROWS synchronously. `delegate` and the tool server's
 * `call` / `callFromUi` are `async function`s — they RETURN A PROMISE and reject instead of
 * throwing, so a synchronous try/catch cannot observe their rejection: use capture (which awaits)
 * for those, or the error escapes as an unhandled rejection and the worker dies. submitEvidence,
 * readEvidence, status, message, control, sweep, reconcile, budgets, the mailbox and the
 * capability registry are synchronous.
 */
const observedCodes = new Set();
const captureSync = (run) => {
  try { run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.field === 'string') {
      observedCodes.add(error.code);
      return { code: error.code, field: error.field };
    }
    return { code: 'not-a-CollaborationError', field: String(error) };
  }
};
const capture = async (run) => {
  try { await run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.field === 'string') {
      observedCodes.add(error.code);
      return { code: error.code, field: error.field };
    }
    return { code: 'not-a-CollaborationError', field: String(error) };
  }
};

/** Every world this case builds, so the boundedness check can read the product's OWN counters. */
const worlds = [];

/**
 * The case world: the REAL delegation service with the `deliver` prompt port — the one seam the
 * product's own signature declares (delegationService.js:185) — backed by a counting, recording
 * fake, the REAL mailbox (injected when a scenario observes it directly), and the REAL tool server
 * over that service. Every member defaults to a distinct native session per harness kind, so the
 * concurrency budget is the only budget that can pair two delegations unless a scenario says
 * otherwise.
 */
function makeWorld(deliver, mailbox) {
  const counters = { deliver: 0 };
  const deliverCalls = [];
  const providedDeliver = deliver ?? (async (input) => {
    deliverCalls.push({
      taskId: input.taskId,
      teamId: input.teamId,
      participantId: input.participantId,
      harnessKind: input.harnessKind,
      session: { ...input.session },
      prompt: input.prompt,
    });
    return { ackId: `ack-${input.taskId}` };
  });
  // EVERY invocation — the default ack fake OR a scenario-supplied custom port — is counted here,
  // BEFORE delegating to providedDeliver. This is the F4 fix: the counter used to live ONLY inside
  // the default branch, so a custom deliver (e.g. ambiguousWorld's `async () => ({})`) never touched
  // it and ambiguousWorld.counters.deliver read 0, while the product genuinely invokes the deliver
  // port exactly once per delegation (delegationService.js:589 calls deliverPrompt once; an
  // unreadable ack settles ambiguous — L603-608 — which is precisely the F4 expectation). The
  // recording array (deliverCalls) stays inside the DEFAULT branch only, so the array a default
  // world exposes (asserted verbatim in H1) is byte-identical to before, and the counter now counts
  // every custom-deliver world too. No assertion reads a custom world's deliverCalls array.
  const deliverPort = async (input) => {
    counters.deliver += 1;
    return providedDeliver(input);
  };
  const box = mailbox ?? createMailbox();
  const service = createDelegationService({ deliver: deliverPort, mailbox: box });
  const server = createToolServer({ delegation: service });
  const world = { service, server, mailbox: box, counters, deliverCalls };
  worlds.push(world);
  return world;
}

/** One team: a lead plus one worker per requested harness kind, each with its OWN minted scope. */
function seedTeam(world, workerKinds) {
  const team = world.service.createTeam({ name: 'delivery team', at: T0 });
  const leadJoin = world.service.addMember({
    teamId: team.teamId, participantId: LEAD, role: 'lead', harnessKind: 'opencode', session: SESSIONS.opencode, at: T0,
  });
  const workers = workerKinds.map((kind) => {
    const seed = WORKERS[kind];
    if (seed === undefined) throw new Error(`no fixture worker for harness ${kind}`);
    const join = world.service.addMember({
      teamId: team.teamId, participantId: seed.participantId, role: 'worker', harnessKind: kind, session: seed.session, at: T0,
    });
    return { participantId: seed.participantId, harnessKind: kind, session: seed.session, scope: join.scope };
  });
  return { team, lead: { member: leadJoin.member, scope: leadJoin.scope }, workers };
}

/** The worker mirror of the browser entry's frozen-contract table. */
function workerTables(inputs) {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION,
    budgets: { ...COLLABORATION_BUDGETS },
    budgetsFrozen: Object.isFrozen(COLLABORATION_BUDGETS),
    limitsFromFunction: { ...collaborationBudgetLimits() },
    budgetReasons: [...BUDGET_REASONS],
    budgetReasonsFrozen: Object.isFrozen(BUDGET_REASONS),
    ceilings: {
      maxTaskTitleChars: MAX_TASK_TITLE_CHARS,
      maxCriteriaCount: MAX_CRITERIA_COUNT,
      maxCriterionIdChars: MAX_CRITERION_ID_CHARS,
      maxCriterionChars: MAX_CRITERION_CHARS,
      maxDeliverables: MAX_DELIVERABLES,
      maxDeliverablePaths: MAX_DELIVERABLE_PATHS,
      maxPathChars: MAX_PATH_CHARS,
      maxMailboxTextChars: MAX_MAILBOX_TEXT_CHARS,
      maxNames: { ...MAX_NAMES },
    },
    harnessKinds: [...HARNESS_KINDS],
    harnessKindsFrozen: Object.isFrozen(HARNESS_KINDS),
    errorCodes: [...ERROR_CODES],
    errorCodeCount: ERROR_CODES.length,
    errorCodesFrozen: Object.isFrozen(ERROR_CODES),
    collaborationErrorShape: (() => {
      const error = new CollaborationError(inputs.contract.errorShape.code, inputs.contract.errorShape.field, inputs.contract.errorShape.detail);
      return {
        name: error.name,
        code: error.code,
        field: error.field,
        reason: error.reason,
        message: error.message,
        detail: error.detail === null ? null : { ...error.detail },
        isProtocolError: error instanceof ProtocolError,
        isTypeError: error instanceof TypeError,
      };
    })(),
    delegationCodesInTable: inputs.contract.delegationCodes
      .every((code) => ERROR_CODES.includes(code)),
    atExplicit: parseAt(inputs.at.explicit),
    atZero: captureSync(() => parseAt(inputs.at.zero)),
    atFractional: captureSync(() => parseAt(inputs.at.fractional)),
  };
}

/**
 * The worker mirror of the browser entry's canonical-session-key table. The five keys are read
 * back from a REAL delegation service's member read models — the sessionKey values the product
 * itself wrote — so the cross-realm equality binds the browser's computation to the product's own
 * records.
 */
function workerSessionKeys() {
  const world = makeWorld();
  const team = world.service.createTeam({ name: 'identity team', at: T0 });
  const joins = [
    world.service.addMember({ teamId: team.teamId, participantId: LEAD, role: 'lead', harnessKind: 'opencode', session: SESSIONS.opencode, at: T0 }),
    world.service.addMember({ teamId: team.teamId, participantId: W_CODEX, role: 'worker', harnessKind: 'codex', session: SESSIONS.codex, at: T0 }),
    world.service.addMember({ teamId: team.teamId, participantId: W_ACP, role: 'worker', harnessKind: 'acp', session: SESSIONS.acp, at: T0 }),
    world.service.addMember({ teamId: team.teamId, participantId: W_KIMI, role: 'worker', harnessKind: 'kimi-web', session: SESSIONS.kimi, at: T0 }),
    world.service.addMember({ teamId: team.teamId, participantId: W_DSH, role: 'worker', harnessKind: 'dsh', session: SESSIONS.dsh, at: T0 }),
  ];
  const byKind = Object.fromEntries(joins.map((join) => [join.member.harnessKind, join.member]));
  const decoded = decodeSessionKey(byKind['kimi-web'].sessionKey);
  return {
    opencode: byKind.opencode.sessionKey,
    codex: byKind.codex.sessionKey,
    acp: byKind.acp.sessionKey,
    kimi: byKind['kimi-web'].sessionKey,
    dsh: byKind.dsh.sessionKey,
    codexDuplicate: encodeSessionKey(parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.codex, nativeSessionId: ID_NATIVE.codex })),
    decoded: { environmentId: decoded.environmentId, harnessInstanceId: decoded.harnessInstanceId, nativeSessionId: decoded.nativeSessionId },
  };
}

/** The worker mirror of the browser entry's parser-boundary table. */
function workerParsers(inputs) {
  return {
    taskId: parseTaskId(inputs.parser.taskId),
    taskIdLowercased: parseTaskId(inputs.parser.taskIdLower),
    badTaskId: captureSync(() => parseTaskId(inputs.parser.badTaskId)),
    teamId: parseTeamId(inputs.parser.teamId),
    badTeamId: captureSync(() => parseTeamId(inputs.parser.badTeamId)),
    messageId: parseMessageId(inputs.parser.messageId),
    badMessageId: captureSync(() => parseMessageId(inputs.parser.badMessageId)),
    teamName512: parseTeamName(inputs.parser.teamName512).length,
    teamNameEmpty: captureSync(() => parseTeamName('')),
    teamName513: captureSync(() => parseTeamName(inputs.parser.teamName513)),
    taskTitle512: parseTaskTitle(inputs.parser.taskTitle512).length,
    taskTitle513: captureSync(() => parseTaskTitle(inputs.parser.taskTitle513)),
    criteriaParsed: parseCriteria(inputs.parser.criteria).map((entry) => ({ id: entry.id, text: entry.text, required: entry.required })),
    criteriaEmpty: captureSync(() => parseCriteria([])),
    criteriaDuplicateIds: captureSync(() => parseCriteria(inputs.parser.criteriaDuplicate)),
    criterionDefaultsRequired: parseCriterion(inputs.parser.criterionA).required,
    criterionRejectsExtraKey: captureSync(() => parseCriterion(inputs.parser.criterionExtra)),
    deliverable: (() => {
      const parsed = parseDeliverable(inputs.parser.evidence);
      return { deliverableId: parsed.deliverableId, artifactHash: parsed.artifactHash, bytes: parsed.bytes, paths: [...parsed.paths] };
    })(),
    deliverableBadHash: captureSync(() => parseDeliverable(inputs.parser.deliverableBadHash)),
    deliverableEmptyPaths: captureSync(() => parseDeliverable(inputs.parser.deliverableEmptyPaths)),
    atExplicit: parseAt(inputs.at.explicit),
    atZero: captureSync(() => parseAt(inputs.at.zero)),
    atFractional: captureSync(() => parseAt(inputs.at.fractional)),
  };
}

export const sourceFiles = [...new Set([
  // the four product modules this task owns
  'bridge/runtime/collaboration/delegationService.js',
  'bridge/runtime/collaboration/mailbox.js',
  'bridge/runtime/collaboration/toolServer.js',
  'bridge/runtime/collaboration/toolCapabilities.js',
  // the product's own regression suite, unchanged
  'app/runtime/delegation.test.ts',
  // the frozen shared contract they all agree on
  'shared/runtime/collaboration.js', 'shared/runtime/collaboration.d.ts',
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'shared/runtime/harnessContract.js', 'shared/runtime/harnessContract.d.ts',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task39.ts',
  'scripts/qa/runtime-v090-cases/task-39.mjs',
  'scripts/qa/runtime-v090-cases/task-39-fixture.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

/**
 * The seven product files whose bytes the evidence must bind to. Every one of them is in
 * sourceFiles, so the independent gate can compare the recorded digests against the artifact's own
 * sourceHashes mechanically.
 */
const PRODUCT_FILES = [
  'bridge/runtime/collaboration/delegationService.js',
  'bridge/runtime/collaboration/mailbox.js',
  'bridge/runtime/collaboration/toolServer.js',
  'bridge/runtime/collaboration/toolCapabilities.js',
  'app/runtime/delegation.test.ts',
  'shared/runtime/collaboration.js',
  'shared/runtime/collaboration.d.ts',
];

function productHashes(root) {
  return Object.fromEntries(PRODUCT_FILES.map((file) => [
    file,
    createHash('sha256').update(readFileSync(path.resolve(root, file))).digest('hex'),
  ]));
}

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 39 registered case</title>
 <style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
 <body><div id="app"></div>
 <script type="module">window.__task39Errors=[];window.addEventListener('error',(e)=>window.__task39Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task39Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
 <script type="module" src="/app/dev/runtime-v090/task39.ts"></script></body></html>`;

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-39/cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const protocol = { node: {}, browser: {} };
  const proof = { case: context.case, runDir, checks, observations, protocol };
  let peakHeap = process.memoryUsage().heapUsed;
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const check = (name, observed, expected) => {
    const left = scrub(observed); const right = scrub(expected);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({
      name,
      surface: 'the real landed bridge Lead/Worker delegation service delegationService.js composed with the real mailbox.js, toolServer.js and toolCapabilities.js over the frozen shared/runtime/collaboration.js + identity.js + harnessContract.js contract in the Node worker, with the service own declared deliver prompt port backed by a counting recording fake, plus the frozen shared contract, the canonical session keys and the shared parsers recomputed in a real headless Chromium served by a case-owned Vite server',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  persist();

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-39.mjs',
    'scripts/qa/runtime-v090-cases/task-39-fixture.mjs',
    'app/dev/runtime-v090/task39.ts',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const productHashesBefore = productHashes(context.root);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;

  // Drives one worker value and its browser twin, then asserts the two realms are IDENTICAL.
  const crossRealm = async (name, workerValue, browserValue, expected) => {
    protocol.node[name] = workerValue;
    protocol.browser[name] = browserValue;
    record(name, { worker: workerValue, browser: browserValue });
    check(name, {
      worker: workerValue,
      browser: browserValue,
      equal: JSON.stringify(workerValue) === JSON.stringify(browserValue),
    }, { worker: expected, browser: expected, equal: true });
  };

  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Real headless Chromium over the frozen shared contract (no shim: no node:* builtin anywhere)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa39', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa39/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task39 && window.task39.ready)), 'task39 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    // ── C1: the frozen contract is identical in both realms ──
    await crossRealm('the frozen collaboration contract every delegation and mailbox rejection travels through — the five coordination budgets (concurrency 4, Session mutation 1, depth 4, children 32, mailbox 1000) taken from the one frozen shared object and reported verbatim by collaborationBudgetLimits, the five budget reasons, every frozen ceiling, the five harness kinds, the CollaborationError shape and the frozen ten-entry ERROR_CODES table — is byte-identical in the browser realm and the bridge worker, every table is frozen, every code the four product modules can emit (invalid_request, unauthorized, unsupported, conflict, cancelled, source_unavailable, reconcile_required) is a member, and the explicit-`at` contract refuses a zero and a fractional reading, so the app and the bridge cannot disagree about a limit, a state name or a rejection', workerTables(SHARED_INPUTS), await evaluate((inputs) => window.task39.tables(inputs), SHARED_INPUTS), {
      schemaVersion: 1,
      budgets: { maxConcurrency: 4, maxSessionMutations: 1, maxDepth: 4, maxChildren: 32, maxMailbox: 1000 },
      budgetsFrozen: true,
      limitsFromFunction: { maxConcurrency: 4, maxSessionMutations: 1, maxDepth: 4, maxChildren: 32, maxMailbox: 1000 },
      budgetReasons: ['collaboration_concurrency', 'collaboration_session_mutation', 'collaboration_depth', 'collaboration_children', 'collaboration_mailbox'],
      budgetReasonsFrozen: true,
      ceilings: {
        maxTaskTitleChars: 512, maxCriteriaCount: 32, maxCriterionIdChars: 128, maxCriterionChars: 512,
        maxDeliverables: 16, maxDeliverablePaths: 64, maxPathChars: 1024, maxMailboxTextChars: 512,
        maxNames: { team: 512, participant: 128, owner: 128, reviewer: 128 },
      },
      harnessKinds: ['opencode', 'codex', 'acp', 'kimi-web', 'dsh'],
      harnessKindsFrozen: true,
      errorCodes: ['invalid_request', 'unsupported', 'version_mismatch', 'unauthorized', 'conflict', 'cancelled', 'timeout', 'source_unavailable', 'reconcile_required', 'replay_required'],
      errorCodeCount: 10,
      errorCodesFrozen: true,
      collaborationErrorShape: { name: 'CollaborationError', code: 'conflict', field: 'delegation_scope', reason: 'delegation_scope', message: 'conflict: collaboration.delegation_scope', detail: { participantId: 'x' }, isProtocolError: true, isTypeError: true },
      delegationCodesInTable: true,
      atExplicit: T0,
      atZero: { code: 'invalid_request', field: 'collaboration_time' },
      atFractional: { code: 'invalid_request', field: 'collaboration_time' },
    });

    // ── C2: the canonical session keys are engine-independent and tie to the real records ──
    await crossRealm('the canonical native-session key each of the five harness kinds produces is identical in both realms — the worker side reading the sessionKey values the REAL addMember wrote into a real member read model — is the SAME key for the same session under a second spelling, and round-trips through decodeSessionKey back to the exact referenced native session, so a browser window and the bridge worker provably agree on the identity a team member carries', workerSessionKeys(), await evaluate((inputs) => window.task39.sessionKeys(inputs), SHARED_INPUTS), {
      opencode: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJlZWVlZWVlZS1lZWVlLTRlZWUtOGVlZS1lZWVlZWVlZWVlZWUiLCJuYXRpdmU6b3BlbmNvZGUtMSJd',
      codex: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
      acp: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJuYXRpdmU6YWNwLTEiXQ',
      kimi: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJjY2NjY2NjYy1jY2NjLTRjY2MtOGNjYy1jY2NjY2NjY2NjY2MiLCJuYXRpdmU6a2ltaS0xIl0',
      dsh: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJkZGRkZGRkZC1kZGRkLTRkZGQtOGRkZC1kZGRkZGRkZGRkZGQiLCJuYXRpdmU6ZHNoLTEiXQ',
      codexDuplicate: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
      decoded: { environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', nativeSessionId: 'native:kimi-1' },
    });

    // ── C3: the parsers every rejection travels through are engine-independent ──
    await crossRealm('the id and shape parsers every rejection travels through — task id, team id and message id lowercasing with their non-UUID refusals, the 512-char team-name and task-title ceilings with the 513th refused, the criteria parser (required defaulting to true, an extra key refused, an empty list and duplicate ids refused with their own codes), the hash-identified deliverable shape with a bad hash and empty paths refused, and the explicit-`at` contract — are byte-identical in both realms, so a rejection the bridge raises is a rejection the app can reproduce', workerParsers(SHARED_INPUTS), await evaluate((inputs) => window.task39.parsers(inputs), SHARED_INPUTS), {
      taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      taskIdLowercased: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      badTaskId: { code: 'invalid_request', field: 'task_id' },
      teamId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      badTeamId: { code: 'invalid_request', field: 'team_id' },
      messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      badMessageId: { code: 'invalid_request', field: 'message_id' },
      teamName512: 512,
      teamNameEmpty: { code: 'invalid_request', field: 'team_name' },
      teamName513: { code: 'invalid_request', field: 'team_name' },
      taskTitle512: 512,
      taskTitle513: { code: 'invalid_request', field: 'task_title' },
      criteriaParsed: [{ id: 'c1', text: 'evidence attached and readable', required: true }],
      criteriaEmpty: { code: 'invalid_request', field: 'task_criteria' },
      criteriaDuplicateIds: { code: 'conflict', field: 'task_criteria' },
      criterionDefaultsRequired: true,
      criterionRejectsExtraKey: { code: 'invalid_request', field: 'task_criteria' },
      deliverable: { deliverableId: 'evidence-bridge-review', artifactHash: 'f'.repeat(64), bytes: 4096, paths: ['bridge/runtime/collaboration/delegationService.js', 'app/runtime/delegation.test.ts'] },
      deliverableBadHash: { code: 'invalid_request', field: 'acceptance_deliverable' },
      deliverableEmptyPaths: { code: 'invalid_request', field: 'acceptance_deliverable' },
      atExplicit: T0,
      atZero: { code: 'invalid_request', field: 'collaboration_time' },
      atFractional: { code: 'invalid_request', field: 'collaboration_time' },
    });

    // TASK39_LANE_MARKER
    if (context.case === 'failure') {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Failure lane: cross-thread/cross-environment tool calls, a malicious delegate input, the
      // infinite recursion and infinite message limits with real counts, the child failure / cancel
      // / restart classes that must terminate or reconcile and never hang, and the closed surface.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── F1: a cross-thread / cross-environment tool call never reaches another scope ──
      {
        const world = makeWorld();
        world.server.registerDriver({ harnessKind: 'opencode', toolInjection: { state: 'supported' } });
        world.server.registerDriver({ harnessKind: 'acp', toolInjection: { state: 'supported' } });
        world.server.registerDriver({ harnessKind: 'codex', toolInjection: { state: 'supported' } });
        const seed = seedTeam(world, ['acp', 'codex']);
        const leadAttachment = world.server.attach({ scope: seed.lead.scope });
        world.server.attach({ scope: seed.workers[0].scope });
        // A hand-forged scope object resolves to NOTHING, on either delivery channel: the caller is
        // identified by a scope handle the delegation service minted, and a forged object is never
        // a key in that map. This is the cross-thread refusal — the scope model carries no thread
        // id, so a caller from another thread/session that cannot present a minted handle is
        // refused before any routing happens.
        const forged = Object.freeze({ role: 'lead', teamId: seed.team.teamId, participantId: LEAD });
        const forgedNative = await capture(() => world.server.call({ scope: forged, tool: 'status', params: {} }));
        const forgedUi = await capture(() => world.server.callFromUi({ scope: forged, tool: 'status', params: {} }));
        const resolvedLead = world.service.resolveScope(seed.lead.scope);
        const resolvedForged = captureSync(() => world.service.resolveScope(forged));
        const unknownTool = await capture(() => world.server.call({ scope: seed.lead.scope, tool: 'nope', params: {} }));
        // The role table is enforced on BOTH channels: the UI path is a delivery channel, not a
        // scope bypass, so a worker cannot delegate or control through it either.
        const workerDelegate = await capture(() => world.server.call({
          scope: seed.workers[0].scope, tool: 'delegate',
          params: { title: 'escape', criteria: CRITERION, workerParticipantId: W_ACP },
        }));
        const workerControlUi = await capture(() => world.server.callFromUi({
          scope: seed.workers[0].scope, tool: 'control', params: { taskId: 'anything', action: 'cancel' },
        }));
        // A second team in the SAME service: its worker exists, but not in this team. Its members sit
        // on their OWN codex native session (SESSIONS.codexTeamB), so team b's in-flight task never
        // collides with team A's codex worker on the per-native-session mutation budget below.
        const bTeam = world.service.createTeam({ name: 'team b', at: T0 });
        const bLeadJoin = world.service.addMember({ teamId: bTeam.teamId, participantId: OTHER_LEAD, role: 'lead', harnessKind: 'codex', session: SESSIONS.codexTeamB, at: T0 });
        world.service.addMember({ teamId: bTeam.teamId, participantId: OTHER_WORKER, role: 'worker', harnessKind: 'codex', session: SESSIONS.codexTeamB, at: T0 });
        const crossTeamDelegate = await capture(() => seed.lead.scope.delegate({
          title: 'cross team work', criteria: CRITERION, workerParticipantId: OTHER_WORKER, at: T0,
        }));
        const foreign = await world.service.delegate(bLeadJoin.scope, {
          title: 'team b work', criteria: CRITERION, workerParticipantId: OTHER_WORKER, at: T0,
        });
        const crossTeamRead = captureSync(() => seed.lead.scope.readEvidence({ taskId: foreign.taskId }));
        const crossTeamControl = captureSync(() => seed.lead.scope.control({ taskId: foreign.taskId, action: 'cancel', at: T0 + 1 }));
        const crossTeamStatus = captureSync(() => seed.lead.scope.status({ taskId: foreign.taskId }));
        // A member from a DIFFERENT environment is refused with both real ids.
        const crossEnv = captureSync(() => world.service.addMember({
          teamId: seed.team.teamId, participantId: CROSS_ENV_MEMBER, role: 'worker', harnessKind: 'acp', session: SESSIONS.otherEnv, at: T0,
        }));
        // A message to a participant outside the team never leaves the sender.
        const strangerMessage = captureSync(() => seed.lead.scope.message({ to: STRANGER, text: 'hello', at: T0 }));
        // A worker's evidence call cannot touch another worker's task.
        const own = await seed.lead.scope.delegate({ title: 'own task', criteria: CRITERION, workerParticipantId: W_ACP, at: T0 + 2 });
        const foreignTask = await seed.lead.scope.delegate({ title: 'foreign task', criteria: CRITERION, workerParticipantId: W_CODEX, at: T0 + 3 });
        const crossWorkerEvidence = captureSync(() => seed.workers[0].scope.submitEvidence({
          taskId: foreignTask.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 4,
        }));
        check('a cross-thread / cross-environment tool call never reaches another scope, on EITHER delivery channel: a hand-forged scope object resolves to nothing through both the native and the UI path (invalid_request/delegation_scope) while the service own resolveScope resolves the REAL minted handle to exactly that member identity (role, teamId, participantId, memberId), an unknown tool name is invalid_request/tool_unknown, and the role table is enforced on the UI path too — a worker cannot delegate or control through callFromUi any more than through call (unauthorized/tool_scope naming the tool and the role); a participant that exists in ANOTHER team is a scope violation rather than an unknown worker (unauthorized/delegation_scope), the same team lead cannot read evidence, control or even ask the status of another team task (unauthorized/delegation_scope), a member from a different environment is refused conflict/delegation_environment, a message to a non-member is unauthorized/mailbox_scope, a worker evidence call for another worker task is unauthorized/delegation_scope naming the task and the caller, and every one of those refusals left nothing behind — the foreign task is still delegated with no evidence, the team still holds exactly its own three members, and the only tasks that exist are the two this team really created plus team b own one', {
          leadAttachment: { mode: leadAttachment.mode, toolCount: leadAttachment.tools.length },
          forgedNative, forgedUi,
          resolvedLead,
          resolvedForged,
          unknownTool,
          workerDelegate,
          workerControlUi,
          crossTeamDelegate,
          foreign: { teamId: foreign.teamId, state: foreign.state },
          crossTeamRead, crossTeamControl, crossTeamStatus,
          crossEnv,
          strangerMessage,
          own: { state: own.state, delegatedTo: own.delegatedTo },
          foreignTask: { state: foreignTask.state, delegatedTo: foreignTask.delegatedTo, evidence: foreignTask.evidence },
          crossWorkerEvidence,
          memberCount: world.service.members(seed.team.teamId).length,
          state: world.service.state(),
        }, {
          leadAttachment: { mode: 'native-mcp', toolCount: 5 },
          forgedNative: { code: 'invalid_request', field: 'delegation_scope' },
          forgedUi: { code: 'invalid_request', field: 'delegation_scope' },
          resolvedLead: { role: 'lead', teamId: seed.team.teamId, participantId: LEAD, memberId: seed.lead.member.memberId },
          resolvedForged: { code: 'invalid_request', field: 'delegation_scope' },
          unknownTool: { code: 'invalid_request', field: 'tool_unknown' },
          workerDelegate: { code: 'unauthorized', field: 'tool_scope' },
          workerControlUi: { code: 'unauthorized', field: 'tool_scope' },
          crossTeamDelegate: { code: 'unauthorized', field: 'delegation_scope' },
          foreign: { teamId: bTeam.teamId, state: 'delegated' },
          crossTeamRead: { code: 'unauthorized', field: 'delegation_scope' },
          crossTeamControl: { code: 'unauthorized', field: 'delegation_scope' },
          crossTeamStatus: { code: 'unauthorized', field: 'delegation_scope' },
          crossEnv: { code: 'conflict', field: 'delegation_environment' },
          strangerMessage: { code: 'unauthorized', field: 'mailbox_scope' },
          own: { state: 'delegated', delegatedTo: W_ACP },
          foreignTask: { state: 'delegated', delegatedTo: W_CODEX, evidence: [] },
          crossWorkerEvidence: { code: 'unauthorized', field: 'delegation_scope' },
          memberCount: 3,
          state: { teams: 2, members: 5, tasks: 3, inFlight: 3, succeeded: 0, failed: 0, cancelled: 0, timeouts: 0, ambiguous: 0, reconciles: 0, closed: false },
        });
      }

      // ── F2: a malicious delegate input is refused before anything is created ──
      {
        const box = createMailbox();
        const world = makeWorld(undefined, box);
        const seed = seedTeam(world, ['acp']);
        const runs = [
          () => seed.lead.scope.delegate({ title: '', criteria: CRITERION, workerParticipantId: W_ACP, at: T0 }),
          () => seed.lead.scope.delegate({ title: 'no criteria', criteria: [], workerParticipantId: W_ACP, at: T0 }),
          () => seed.lead.scope.delegate({
            title: 'duplicate criteria',
            criteria: [{ id: 'c1', text: 'a' }, { id: 'c1', text: 'b' }],
            workerParticipantId: W_ACP,
            at: T0,
          }),
          () => seed.lead.scope.delegate({ title: 'bad worker', criteria: CRITERION, workerParticipantId: 'not-a-uuid', at: T0 }),
          () => seed.lead.scope.delegate({ title: 'unknown worker', criteria: CRITERION, workerParticipantId: UNKNOWN_PARTICIPANT, at: T0 }),
          () => seed.lead.scope.delegate({ title: 'lead is not a worker', criteria: CRITERION, workerParticipantId: LEAD, at: T0 }),
          () => seed.lead.scope.delegate({ title: 'x'.repeat(513), criteria: CRITERION, workerParticipantId: W_ACP, at: T0 }),
          () => seed.lead.scope.delegate({ title: 'huge prompt', criteria: CRITERION, workerParticipantId: W_ACP, prompt: 'x'.repeat(32769), at: T0 }),
          () => seed.lead.scope.delegate({ title: 'bad parent', criteria: CRITERION, workerParticipantId: W_ACP, parentTaskId: 'not-a-task', at: T0 }),
          () => seed.lead.scope.delegate({ title: 'unknown parent', criteria: CRITERION, workerParticipantId: W_ACP, parentTaskId: UNKNOWN_PARENT, at: T0 }),
          () => seed.lead.scope.delegate({ title: 'negative timeout', criteria: CRITERION, workerParticipantId: W_ACP, timeoutMs: -1, at: T0 }),
          () => seed.lead.scope.delegate({ title: 'bad policy', criteria: CRITERION, workerParticipantId: W_ACP, childFailure: 'nope', at: T0 }),
        ];
        const rejections = [];
        for (const run of runs) rejections.push(await capture(run));
        check('a malicious delegate input is refused BEFORE anything is created, each with its own explicit code and plain rejection field: an empty title and a 513-char title are invalid_request/task_title, an empty criteria list and a duplicate criteria id are invalid_request and conflict task_criteria, a non-UUID worker is invalid_request/delegation_participant, a worker that exists nowhere is invalid_request/delegation_worker_unknown, naming the LEAD as the worker is unauthorized/delegation_role, a 32769-char prompt is invalid_request/delegation_prompt, a non-UUID parent is invalid_request/task_id and a well-formed but unknown parent is invalid_request/delegation_task_unknown, a negative timeout is invalid_request/delegation_timeout and an unknown child-failure policy is invalid_request/delegation_child_failure — and after all twelve the service created ZERO tasks, the deliver port saw ZERO calls, the team mailbox holds ZERO messages and the used budgets read zero across the board, so nothing was created, sent or written', {
          rejections,
          fields: rejections.map((entry) => entry.field),
          codes: rejections.map((entry) => entry.code),
          deliverCalls: world.counters.deliver,
          tasks: world.service.state().tasks,
          mailbox: { ...box.state(), depth: box.depth(seed.team.teamId) },
          used: world.service.budgets().used,
          members: world.service.members(seed.team.teamId).length,
        }, {
          rejections: [
            { code: 'invalid_request', field: 'task_title' },
            { code: 'invalid_request', field: 'task_criteria' },
            { code: 'conflict', field: 'task_criteria' },
            { code: 'invalid_request', field: 'delegation_participant' },
            { code: 'invalid_request', field: 'delegation_worker_unknown' },
            { code: 'unauthorized', field: 'delegation_role' },
            { code: 'invalid_request', field: 'task_title' },
            { code: 'invalid_request', field: 'delegation_prompt' },
            { code: 'invalid_request', field: 'task_id' },
            { code: 'invalid_request', field: 'delegation_task_unknown' },
            { code: 'invalid_request', field: 'delegation_timeout' },
            { code: 'invalid_request', field: 'delegation_child_failure' },
          ],
          fields: [
            'task_title', 'task_criteria', 'task_criteria', 'delegation_participant', 'delegation_worker_unknown',
            'delegation_role', 'task_title', 'delegation_prompt', 'task_id', 'delegation_task_unknown',
            'delegation_timeout', 'delegation_child_failure',
          ],
          codes: [
            'invalid_request', 'invalid_request', 'conflict', 'invalid_request', 'invalid_request', 'unauthorized',
            'invalid_request', 'invalid_request', 'invalid_request', 'invalid_request', 'invalid_request', 'invalid_request',
          ],
          deliverCalls: 0,
          tasks: 0,
          mailbox: { teams: 1, participants: 2, messages: 0, posted: 0, closed: false, depth: 0 },
          used: { concurrency: 0, sessionMutations: 0, depth: 0, children: 0, mailbox: 0 },
          members: 2,
        });
      }
      // ── F3: infinite recursion and infinite messages terminate at the real counts ──
      {
        // depth 4: a chain 1..4 is admitted, the fifth link is refused with the real depth.
        const depthWorld = makeWorld();
        const depthSeed = seedTeam(depthWorld, ['acp', 'codex', 'kimi-web', 'dsh']);
        let parent = await depthSeed.lead.scope.delegate({
          title: 'level 1', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        await depthSeed.workers[0].scope.submitEvidence({ taskId: parent.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 1 });
        const chainDepths = [parent.depth];
        for (let depth = 2; depth <= COLLABORATION_BUDGETS.maxDepth; depth += 1) {
          const child = await depthSeed.lead.scope.delegate({
            title: `level ${depth}`,
            criteria: CRITERION,
            workerParticipantId: depthSeed.workers[depth - 1].participantId,
            parentTaskId: parent.taskId,
            at: T0 + depth,
          });
          chainDepths.push(child.depth);
          await depthSeed.workers[depth - 1].scope.submitEvidence({
            taskId: child.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + depth,
          });
          parent = child;
        }
        const tooDeep = await capture(() => depthSeed.lead.scope.delegate({
          title: 'level 5', criteria: CRITERION, workerParticipantId: W_ACP, parentTaskId: parent.taskId, at: T0 + 10,
        }));
        // An UNBOUNDED recursion attempt terminates at the same refusal: the loop below keeps
        // delegating until the product refuses, and it always does — the case itself completing is
        // the no-hang evidence.
        const unboundedWorld = makeWorld();
        const unboundedSeed = seedTeam(unboundedWorld, ['acp', 'codex', 'kimi-web', 'dsh']);
        let unboundedParent = await unboundedSeed.lead.scope.delegate({
          title: 'root', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        await unboundedSeed.workers[0].scope.submitEvidence({ taskId: unboundedParent.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 1 });
        let unboundedRefused = null;
        let unboundedSteps = 1;
        for (let step = 2; step <= 12 && unboundedRefused === null; step += 1) {
          let created;
          try {
            created = await unboundedSeed.lead.scope.delegate({
              title: `chain ${step}`,
              criteria: CRITERION,
              workerParticipantId: unboundedSeed.workers[(step - 1) % 4].participantId,
              parentTaskId: unboundedParent.taskId,
              at: T0 + step,
            });
          } catch (error) {
            unboundedRefused = captureSync(() => { throw error; });
            break;
          }
          unboundedSteps += 1;
          await unboundedSeed.workers[(step - 1) % 4].scope.submitEvidence({
            taskId: created.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + step,
          });
          unboundedParent = created;
        }
        // children 32: the first thirty-two children are admitted, the thirty-third is refused.
        const childrenWorld = makeWorld();
        const childrenSeed = seedTeam(childrenWorld, ['acp']);
        const root = await childrenSeed.lead.scope.delegate({
          title: 'root', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        await childrenSeed.workers[0].scope.submitEvidence({ taskId: root.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 1 });
        const childDepths = [];
        for (let index = 0; index < COLLABORATION_BUDGETS.maxChildren; index += 1) {
          const child = await childrenSeed.lead.scope.delegate({
            title: `child ${index}`,
            criteria: CRITERION,
            workerParticipantId: W_ACP,
            parentTaskId: root.taskId,
            at: T0 + 2 + index,
          });
          childDepths.push(child.depth);
          await childrenSeed.workers[0].scope.submitEvidence({
            taskId: child.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 2 + index,
          });
        }
        const thirtyThird = await capture(() => childrenSeed.lead.scope.delegate({
          title: 'child 32', criteria: CRITERION, workerParticipantId: W_ACP, parentTaskId: root.taskId, at: T0 + 100,
        }));
        // mailbox 1000: exactly one thousand notices are held, the 1001st is refused, and a
        // delegation that owes the team a notice is refused with the same real counts.
        const mailboxWorld = makeWorld();
        const mailboxSeed = seedTeam(mailboxWorld, ['acp']);
        for (let index = 0; index < COLLABORATION_BUDGETS.maxMailbox; index += 1) {
          mailboxSeed.lead.scope.message({ to: W_ACP, text: `notice ${index}`, at: T0 + index });
        }
        const overflow = captureSync(() => mailboxSeed.lead.scope.message({ to: W_ACP, text: 'one too many', at: T0 + 2000 }));
        const fullDelegate = await capture(() => mailboxSeed.lead.scope.delegate({
          title: 'no room for the notice', criteria: CRITERION, workerParticipantId: W_ACP, at: T0 + 2001,
        }));
        // The remaining two budgets, with their own real counts.
        const concurrencyWorld = makeWorld();
        const concurrencySeed = seedTeam(concurrencyWorld, ['acp', 'codex', 'kimi-web', 'dsh']);
        for (let index = 0; index < COLLABORATION_BUDGETS.maxConcurrency; index += 1) {
          await concurrencySeed.lead.scope.delegate({
            title: `parallel ${index}`,
            criteria: CRITERION,
            workerParticipantId: concurrencySeed.workers[index].participantId,
            at: T0 + index,
          });
        }
        const fifthConcurrent = await capture(() => concurrencySeed.lead.scope.delegate({
          title: 'parallel 4', criteria: CRITERION, workerParticipantId: W_ACP, at: T0 + 10,
        }));
        const sessionWorld = makeWorld();
        const sessionSeed = seedTeam(sessionWorld, ['acp']);
        const sessionFirst = await sessionSeed.lead.scope.delegate({
          title: 'first', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        const secondSameSession = await capture(() => sessionSeed.lead.scope.delegate({
          title: 'second', criteria: CRITERION, workerParticipantId: W_ACP, at: T0 + 1,
        }));
        check('infinite recursion and infinite messages TERMINATE at the real counts, never hang and never silently drop: a delegation chain derives its depths as [1,2,3,4] and the fifth link is refused conflict/collaboration_depth with {depth: 5, limit: 4} leaving exactly four tasks, and an UNBOUNDED recursion attempt breaks at that same refusal after exactly four created links; one parent admits exactly its first thirty-two children (each at depth 2) and the thirty-third is refused conflict/collaboration_children with {parentTaskId, children: 32, limit: 32} while the parent really still holds 32 children and the service holds 33 tasks; the team mailbox holds exactly 1000 notices, the 1001st post is refused conflict/mailbox_full with {teamId, limit: 1000, used: 1000} leaving the depth at 1000, and a delegation that owes the team a notice is refused conflict/collaboration_mailbox with the same counts having created zero tasks; the fifth concurrent delegation is refused conflict/collaboration_concurrency with {running: 4, limit: 4} and a second concurrent delegation on ONE native session is refused conflict/collaboration_session_mutation with {sessionKey, limit: 1} — every limit is the shared frozen object read through the service own budgets read model (identity, not a copy), and every refusal carries the REAL numbers', {
          depth: {
            chainDepths,
            tooDeep,
            tasksAfterRefusal: depthWorld.service.state().tasks,
            unbounded: { refused: unboundedRefused, createdLinks: unboundedSteps, tasks: unboundedWorld.service.state().tasks },
          },
          children: {
            childDepths,
            thirtyThird,
            parentChildren: childrenWorld.service.task(root.taskId).children.length,
            tasks: childrenWorld.service.state().tasks,
          },
          mailbox: {
            depth: mailboxWorld.mailbox.depth(mailboxSeed.team.teamId),
            overflow,
            depthAfterOverflow: mailboxWorld.mailbox.depth(mailboxSeed.team.teamId),
            fullDelegate,
            tasks: mailboxWorld.service.state().tasks,
            state: { ...mailboxWorld.mailbox.state() },
          },
          concurrency: { fifth: fifthConcurrent, running: concurrencyWorld.service.state().inFlight },
          sessionMutation: {
            first: { state: sessionFirst.state, workerHarnessKind: sessionFirst.workerHarnessKind },
            second: secondSameSession,
            sessionKey: encodeSessionKey(SESSIONS.acp),
          },
          limitsAreTheSharedObject: [
            depthWorld.service.budgets().limits === COLLABORATION_BUDGETS,
            childrenWorld.service.budgets().limits === COLLABORATION_BUDGETS,
            mailboxWorld.service.budgets().limits === COLLABORATION_BUDGETS,
          ],
        }, {
          depth: {
            chainDepths: [1, 2, 3, 4],
            tooDeep: { code: 'conflict', field: 'collaboration_depth' },
            tasksAfterRefusal: 4,
            unbounded: { refused: { code: 'conflict', field: 'collaboration_depth' }, createdLinks: 4, tasks: 4 },
          },
          children: {
            childDepths: Array.from({ length: 32 }, () => 2),
            thirtyThird: { code: 'conflict', field: 'collaboration_children' },
            parentChildren: 32,
            tasks: 33,
          },
          mailbox: {
            depth: 1000,
            overflow: { code: 'conflict', field: 'mailbox_full' },
            depthAfterOverflow: 1000,
            fullDelegate: { code: 'conflict', field: 'collaboration_mailbox' },
            tasks: 0,
            state: { teams: 1, participants: 2, messages: 1000, posted: 1000, closed: false },
          },
          concurrency: { fifth: { code: 'conflict', field: 'collaboration_concurrency' }, running: 4 },
          sessionMutation: {
            first: { state: 'delegated', workerHarnessKind: 'acp' },
            second: { code: 'conflict', field: 'collaboration_session_mutation' },
            sessionKey: encodeSessionKey(SESSIONS.acp),
          },
          limitsAreTheSharedObject: [true, true, true],
        });
      }

      // ── F4: a child failure, a cancel and a restart each TERMINATE or RECONCILE, never hang ──
      {
        // A deliver failure fails ONLY its own task, carrying the typed rejection verbatim, and
        // releases the slot so the same worker can be delegated again.
        let codexFailed = false;
        const failureWorld = makeWorld(async (input) => {
          if (input.participantId === W_CODEX && !codexFailed) {
            codexFailed = true;
            throw new CollaborationError('source_unavailable', 'delegation_send');
          }
          return { ackId: `ack-${input.taskId}` };
        });
        const failureSeed = seedTeam(failureWorld, ['acp', 'codex']);
        const healthy = await failureSeed.lead.scope.delegate({
          title: 'healthy', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        const failed = await failureSeed.lead.scope.delegate({
          title: 'unreachable', criteria: CRITERION, workerParticipantId: W_CODEX, at: T0 + 1,
        });
        const retry = await failureSeed.lead.scope.delegate({
          title: 'retry', criteria: CRITERION, workerParticipantId: W_CODEX, at: T0 + 2,
        });
        // A PLAIN Error from the deliver port is classified to the fallback and its message never
        // leaks into the recorded resolution.
        const plainWorld = makeWorld(async () => { throw new Error('RAW-SECRET-socket-hangup'); });
        const plainSeed = seedTeam(plainWorld, ['acp']);
        const plainFailed = await plainSeed.lead.scope.delegate({
          title: 'plain error', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        // A deliver result with no readable ack is a STOP at ambiguous: retained, never retried.
        const ambiguousWorld = makeWorld(async () => ({}));
        const ambiguousSeed = seedTeam(ambiguousWorld, ['acp']);
        const ambiguous = await ambiguousSeed.lead.scope.delegate({
          title: 'ambiguous send', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        // A late worker report cannot resurrect a terminal task.
        const lateWorld = makeWorld();
        const lateSeed = seedTeam(lateWorld, ['acp']);
        const lateTask = await lateSeed.lead.scope.delegate({
          title: 'cancelled work', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        lateSeed.lead.scope.control({ taskId: lateTask.taskId, action: 'cancel', at: T0 + 1 });
        const lateReport = captureSync(() => lateSeed.workers[0].scope.submitEvidence({
          taskId: lateTask.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 2,
        }));
        // A restart retains every unresolved delegation as ambiguous and dispatches nothing.
        const restartWorld = makeWorld();
        const restartSeed = seedTeam(restartWorld, ['acp', 'codex']);
        const restartFirst = await restartSeed.lead.scope.delegate({
          title: 'first', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        const restartSecond = await restartSeed.lead.scope.delegate({
          title: 'second', criteria: CRITERION, workerParticipantId: W_CODEX, at: T0 + 1,
        });
        await restartSeed.workers[0].scope.submitEvidence({ taskId: restartFirst.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 2 });
        const reconciled = restartWorld.service.reconcile({ at: T0 + 9999 });
        const reconciledAgain = restartWorld.service.reconcile({ at: T0 + 10000 });
        check('a child failure, a cancel and a restart each TERMINATE or RECONCILE and never hang: a deliver failure settles ONLY its own task failed with the typed resolution source_unavailable/delegation_send while the sibling stays delegated, and the released slot admits the same worker again (inFlight 1 then 2); a deliver port that rejects with a PLAIN Error is classified to the same fallback and its raw message never reaches the recorded resolution; a deliver result with no readable ack is a STOP at ambiguous with reconcile_required/delegation_ambiguous, retained and never retried (inFlight back to 0, one ambiguous, nothing re-sent); a late worker report after a cancel cannot resurrect the terminal task (conflict/delegation_state with the task still cancelled and its evidence still empty); and a restart retains every unresolved delegation as ambiguous with reconcile_required/delegation_restart_ambiguous while RestartView.dispatched stays empty BY CONSTRUCTION, the reconcile counter steps once, inFlight returns to 0, a second restart retains nothing new — every class reached a terminal or reconcile state and the case itself completed, so no scenario hung', {
          deliverFailure: {
            failed: { state: failed.state, resolution: failed.resolution, endedAt: failed.endedAt },
            sibling: { state: healthy.state },
            retry: { state: retry.state, workerHarnessKind: retry.workerHarnessKind },
            inFlightAfterRetry: failureWorld.service.state().inFlight,
          },
          plainError: {
            state: plainFailed.state,
            resolution: plainFailed.resolution,
            rawMessageLeaked: JSON.stringify(plainFailed.resolution).includes('RAW-SECRET-socket-hangup'),
          },
          ambiguousSend: {
            state: ambiguous.state,
            resolution: ambiguous.resolution,
            ambiguous: ambiguousWorld.service.state().ambiguous,
            inFlight: ambiguousWorld.service.state().inFlight,
            deliverCalls: ambiguousWorld.counters.deliver,
          },
          lateReport: {
            rejection: lateReport,
            state: lateWorld.service.task(lateTask.taskId).state,
            evidence: lateWorld.service.task(lateTask.taskId).evidence,
          },
          restart: {
            retained: reconciled.retained.map((entry) => entry.taskId),
            retainedStates: reconciled.retained.map((entry) => entry.state),
            dispatched: reconciled.dispatched,
            view: { state: restartWorld.service.task(restartSecond.taskId).state, resolution: restartWorld.service.task(restartSecond.taskId).resolution },
            first: { state: restartWorld.service.task(restartFirst.taskId).state },
            reconciles: restartWorld.service.state().reconciles,
            inFlight: restartWorld.service.state().inFlight,
            again: { retained: reconciledAgain.retained, dispatched: reconciledAgain.dispatched },
          },
        }, {
          deliverFailure: {
            failed: { state: 'failed', resolution: { code: 'source_unavailable', field: 'delegation_send' }, endedAt: T0 + 1 },
            sibling: { state: 'delegated' },
            retry: { state: 'delegated', workerHarnessKind: 'codex' },
            inFlightAfterRetry: 2,
          },
          plainError: {
            state: 'failed',
            resolution: { code: 'source_unavailable', field: 'delegation_send' },
            rawMessageLeaked: false,
          },
          ambiguousSend: {
            state: 'ambiguous',
            resolution: { code: 'reconcile_required', field: 'delegation_ambiguous' },
            ambiguous: 1,
            inFlight: 0,
            deliverCalls: 1,
          },
          lateReport: {
            rejection: { code: 'conflict', field: 'delegation_state' },
            state: 'cancelled',
            evidence: [],
          },
          restart: {
            retained: [restartSecond.taskId],
            retainedStates: ['ambiguous'],
            dispatched: [],
            view: { state: 'ambiguous', resolution: { code: 'reconcile_required', field: 'delegation_restart_ambiguous' } },
            first: { state: 'succeeded' },
            reconciles: 1,
            inFlight: 0,
            again: { retained: [], dispatched: [] },
          },
        });
      }
      // ── F5: after close every entry point refuses with an explicit code ──
      {
        const world = makeWorld();
        const seed = seedTeam(world, ['acp']);
        const task = await seed.lead.scope.delegate({
          title: 'open work', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        world.service.close();
        const serviceRefusals = {
          createTeam: captureSync(() => world.service.createTeam({ name: 'late', at: T0 })),
          addMember: captureSync(() => world.service.addMember({ teamId: seed.team.teamId, participantId: STRANGER, role: 'worker', harnessKind: 'acp', session: SESSIONS.acp, at: T0 })),
          team: captureSync(() => world.service.team(seed.team.teamId)),
          teams: captureSync(() => world.service.teams()),
          member: captureSync(() => world.service.member(seed.lead.member.memberId)),
          members: captureSync(() => world.service.members(seed.team.teamId)),
          task: captureSync(() => world.service.task(task.taskId)),
          tasks: captureSync(() => world.service.tasks(seed.team.teamId)),
          submitEvidence: captureSync(() => seed.workers[0].scope.submitEvidence({ taskId: task.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 })),
          readEvidence: captureSync(() => seed.lead.scope.readEvidence({ taskId: task.taskId })),
          status: captureSync(() => seed.lead.scope.status({})),
          message: captureSync(() => seed.lead.scope.message({ to: W_ACP, text: 'late', at: T0 })),
          control: captureSync(() => seed.lead.scope.control({ taskId: task.taskId, action: 'cancel', at: T0 })),
          sweep: captureSync(() => world.service.sweep({ at: T0 })),
          reconcile: captureSync(() => world.service.reconcile({ at: T0 })),
          budgets: captureSync(() => world.service.budgets()),
          delegate: await capture(() => seed.lead.scope.delegate({ title: 'late', criteria: CRITERION, workerParticipantId: W_ACP, at: T0 })),
        };
        const serviceState = world.service.state();
        // OBSERVED AND RECORDED, NOT FORCED: resolveScope does NOT call assertOpen, so after close
        // it reads the cleared map and refuses invalid_request/delegation_scope rather than the
        // cancelled/delegation_service_closed every asserting entry point carries.
        const resolveScopeAfterClose = captureSync(() => world.service.resolveScope(seed.lead.scope));
        world.server.close();
        const serverRefusals = {
          attach: captureSync(() => world.server.attach({ scope: seed.lead.scope })),
          detach: captureSync(() => world.server.detach({ scope: seed.lead.scope })),
          availability: captureSync(() => world.server.availability({ scope: seed.lead.scope })),
          call: await capture(() => world.server.call({ scope: seed.lead.scope, tool: 'status', params: {} })),
          callFromUi: await capture(() => world.server.callFromUi({ scope: seed.lead.scope, tool: 'status', params: {} })),
        };
        const serverState = world.server.state();
        const box = createMailbox();
        const mailboxTeam = '15151515-1515-4515-8515-151515151541';
        box.openTeam({ teamId: mailboxTeam, at: T0 });
        box.addParticipant({ teamId: mailboxTeam, participantId: W_ACP, at: T0 });
        box.addParticipant({ teamId: mailboxTeam, participantId: W_CODEX, at: T0 });
        box.close();
        const mailboxRefusals = {
          openTeam: captureSync(() => box.openTeam({ teamId: mailboxTeam, at: T0 })),
          team: captureSync(() => box.team(mailboxTeam)),
          teams: captureSync(() => box.teams()),
          addParticipant: captureSync(() => box.addParticipant({ teamId: mailboxTeam, participantId: W_DSH, at: T0 })),
          post: captureSync(() => box.post({ teamId: mailboxTeam, from: W_ACP, to: W_CODEX, text: 'late', at: T0 })),
          messages: captureSync(() => box.messages({ teamId: mailboxTeam, participantId: W_ACP })),
          rehydrate: captureSync(() => box.rehydrate({ version: 1, teams: [] })),
          // OBSERVED AND RECORDED, NOT FORCED: depth and snapshot do NOT call assertOpen (mailbox.js
          // depth L203-205, snapshot L207-217), so after close they read the ALREADY-CLEARED
          // teamsById. depth is a requireTeam lookup — the team is gone, so it refuses
          // invalid_request/mailbox_team. snapshot takes no id and reads teamsById directly — the
          // map is empty, so it SUCCEEDS and returns {version:1, teams:[]}, i.e. the capture success
          // envelope {code:null, field:null}; a read accessor, never a refusal.
          depth: captureSync(() => box.depth(mailboxTeam)),
          snapshot: captureSync(() => box.snapshot()),
        };
        check('after close every asserting entry point refuses with an explicit typed code — the delegation service refuses all seventeen of them cancelled/delegation_service_closed (the async delegate through its own rejection, never a bare throw) while state() still reports the frozen counters with closed true — tasks stays 1 (the FROZEN monotonic stats.tasks) but inFlight drops to 0 because close() clears tasksById, so inFlight is a LIVE inFlightTasks().length and tasks a frozen counter, two correct values that differ after the close — the tool server refuses attach, detach, availability, call and callFromUi cancelled/tool_server_closed while its state() still reports closed true, and the mailbox refuses openTeam, team, teams, addParticipant, post, messages and rehydrate cancelled/mailbox_closed — and the three accessors that do NOT assert open (resolveScope, the mailbox depth and the mailbox snapshot) are OBSERVED AND RECORDED, NOT FORCED: they read the already-cleared maps, so resolveScope and the mailbox depth refuse invalid_request/delegation_scope and invalid_request/mailbox_team while the mailbox snapshot takes no id, reads the emptied teamsById and SUCCEEDS with the capture success envelope {code:null, field:null} (never a refusal), so a closed service can be inspected but never written', {
          serviceRefusals,
          serviceState,
          resolveScopeAfterClose,
          serverRefusals,
          serverState,
          mailboxRefusals,
        }, {
          serviceRefusals: {
            createTeam: { code: 'cancelled', field: 'delegation_service_closed' },
            addMember: { code: 'cancelled', field: 'delegation_service_closed' },
            team: { code: 'cancelled', field: 'delegation_service_closed' },
            teams: { code: 'cancelled', field: 'delegation_service_closed' },
            member: { code: 'cancelled', field: 'delegation_service_closed' },
            members: { code: 'cancelled', field: 'delegation_service_closed' },
            task: { code: 'cancelled', field: 'delegation_service_closed' },
            tasks: { code: 'cancelled', field: 'delegation_service_closed' },
            submitEvidence: { code: 'cancelled', field: 'delegation_service_closed' },
            readEvidence: { code: 'cancelled', field: 'delegation_service_closed' },
            status: { code: 'cancelled', field: 'delegation_service_closed' },
            message: { code: 'cancelled', field: 'delegation_service_closed' },
            control: { code: 'cancelled', field: 'delegation_service_closed' },
            sweep: { code: 'cancelled', field: 'delegation_service_closed' },
            reconcile: { code: 'cancelled', field: 'delegation_service_closed' },
            budgets: { code: 'cancelled', field: 'delegation_service_closed' },
            delegate: { code: 'cancelled', field: 'delegation_service_closed' },
          },
          serviceState: { teams: 1, members: 2, tasks: 1, inFlight: 0, succeeded: 0, failed: 0, cancelled: 0, timeouts: 0, ambiguous: 0, reconciles: 0, closed: true },
          resolveScopeAfterClose: { code: 'invalid_request', field: 'delegation_scope' },
          serverRefusals: {
            attach: { code: 'cancelled', field: 'tool_server_closed' },
            detach: { code: 'cancelled', field: 'tool_server_closed' },
            availability: { code: 'cancelled', field: 'tool_server_closed' },
            call: { code: 'cancelled', field: 'tool_server_closed' },
            callFromUi: { code: 'cancelled', field: 'tool_server_closed' },
          },
          serverState: { tools: 5, nativeCalls: 0, uiCalls: 0, refused: 0, attached: 0, closed: true },
          mailboxRefusals: {
            openTeam: { code: 'cancelled', field: 'mailbox_closed' },
            team: { code: 'cancelled', field: 'mailbox_closed' },
            teams: { code: 'cancelled', field: 'mailbox_closed' },
            addParticipant: { code: 'cancelled', field: 'mailbox_closed' },
            post: { code: 'cancelled', field: 'mailbox_closed' },
            messages: { code: 'cancelled', field: 'mailbox_closed' },
            rehydrate: { code: 'cancelled', field: 'mailbox_closed' },
            depth: { code: 'invalid_request', field: 'mailbox_team' },
            // OBSERVED AND RECORDED, NOT FORCED: snapshot does NOT assert open — after close it reads
            // the emptied teamsById and SUCCEEDS, so the envelope is the capture success
            // {code:null, field:null}, never a cancelled/mailbox_closed refusal (mailbox.js:207-217).
            snapshot: { code: null, field: null },
          },
        });
      }
    } else {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Happy lane: one native-MCP-capable lead delegating to two workers of different sources,
      // the evidence round trip, the message round trip with parent causality through the
      // persistent mailbox, the UI-only driver dispatching through the UI by the same mechanism,
      // the whole command surface actually started, and cascade cancel plus the timeout sweep.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── H1: one native-MCP-capable lead → two workers of different sources ──
      {
        const world = makeWorld();
        world.server.registerDriver({ harnessKind: 'opencode', toolInjection: { state: 'supported' } });
        world.server.registerDriver({ harnessKind: 'acp', toolInjection: { state: 'unsupported', code: 'unsupported', reason: UI_LIMITATION } });
        world.server.registerDriver({ harnessKind: 'codex', toolInjection: { state: 'supported' } });
        const seed = seedTeam(world, ['acp', 'codex']);
        const leadAttachment = world.server.attach({ scope: seed.lead.scope });
        const acpAttachment = world.server.attach({ scope: seed.workers[0].scope });
        const codexAttachment = world.server.attach({ scope: seed.workers[1].scope });
        const taskAcp = await world.server.call({
          scope: seed.lead.scope, tool: 'delegate',
          params: { title: 'review the bridge runtime', criteria: CRITERION, workerParticipantId: W_ACP, at: T0 },
        });
        const taskCodex = await world.server.call({
          scope: seed.lead.scope, tool: 'delegate',
          params: { title: 'audit the codex transport', criteria: CRITERION, workerParticipantId: W_CODEX, prompt: 'audit the codex transport and report', at: T0 + 1 },
        });
        check('one native-MCP-capable lead delegates to two workers of DIFFERENT sources and the OBSERVED team shape is asserted whole: the team reports its three members and two tasks with a mailbox depth of 2 (one delegation notice per task), each member carries its OWN harness identity (lead opencode, workers acp and codex) with the canonical session key the real addMember wrote, the frozen five-tool role table is the contract (delegate and control are lead-only; status, message and evidence are lead+worker) with every descriptor and its roles frozen, the two injection modes are the frozen pair native-mcp/ui-only and the two delegation roles the frozen pair lead/worker; the native-mcp lead attaches the five TEMPORARY scoped tools in the frozen table order while the ui-only acp worker attaches NONE and the native-mcp codex worker attaches its own five; both delegations are OBSERVED as delegated with workerHarnessKind acp and codex respectively against leadHarnessKind opencode (never equal), depth 1, no parent, the independent child-failure default, no timeout and therefore no deadline, and the deliver port received exactly the two prompts verbatim — the acp one defaulting to its title and the codex one carrying its explicit prompt — each addressed to its OWN worker native session, so the lead really delegated across harnesses', {
          team: { ...world.service.team(seed.team.teamId) },
          members: world.service.members(seed.team.teamId).map((view) => ({
            participantId: view.participantId, role: view.role, harnessKind: view.harnessKind, sessionKey: view.sessionKey, nativeSessionId: view.session.nativeSessionId,
          })),
          tools: world.server.tools().map((tool) => ({ name: tool.name, roles: [...tool.roles] })),
          frozen: {
            toolTable: Object.isFrozen(world.server.tools()),
            everyDescriptorFrozen: world.server.tools().every((tool) => Object.isFrozen(tool) && Object.isFrozen(tool.roles)),
            injectionModes: [...TOOL_INJECTION_MODES],
            injectionModesFrozen: Object.isFrozen(TOOL_INJECTION_MODES),
            roles: [...DELEGATION_ROLES],
            rolesFrozen: Object.isFrozen(DELEGATION_ROLES),
          },
          attachments: {
            lead: { mode: leadAttachment.mode, injectable: leadAttachment.injectable, limitation: leadAttachment.limitation, tools: leadAttachment.tools.map((tool) => tool.name) },
            acp: { mode: acpAttachment.mode, injectable: acpAttachment.injectable, limitation: acpAttachment.limitation, tools: acpAttachment.tools.length },
            codex: { mode: codexAttachment.mode, injectable: codexAttachment.injectable, tools: codexAttachment.tools.length },
          },
          taskAcp: {
            state: taskAcp.state, workerHarnessKind: taskAcp.workerHarnessKind, leadHarnessKind: taskAcp.leadHarnessKind,
            harnessesDiffer: taskAcp.workerHarnessKind !== taskAcp.leadHarnessKind,
            delegatedTo: taskAcp.delegatedTo, delegatedBy: taskAcp.delegatedBy, depth: taskAcp.depth, parentId: taskAcp.parentId,
            childFailure: taskAcp.childFailure, prompt: taskAcp.prompt, timeoutMs: taskAcp.timeoutMs, deadlineAt: taskAcp.deadlineAt,
            criteria: taskAcp.criteria.map((entry) => ({ id: entry.id, required: entry.required })),
          },
          taskCodex: {
            state: taskCodex.state, workerHarnessKind: taskCodex.workerHarnessKind, leadHarnessKind: taskCodex.leadHarnessKind,
            harnessesDiffer: taskCodex.workerHarnessKind !== taskCodex.leadHarnessKind,
            delegatedTo: taskCodex.delegatedTo, depth: taskCodex.depth, prompt: taskCodex.prompt,
          },
          deliverCalls: world.deliverCalls,
          mintedIds: {
            teamId: UUID.test(seed.team.teamId),
            memberIds: world.service.members(seed.team.teamId).map((view) => UUID.test(view.memberId)),
            taskIds: [taskAcp.taskId, taskCodex.taskId].map((taskId) => UUID.test(taskId)),
            distinctMemberIds: new Set(world.service.members(seed.team.teamId).map((view) => view.memberId)).size,
          },
          used: world.service.budgets().used,
          serverState: { ...world.server.state() },
        }, {
          team: { teamId: seed.team.teamId, name: 'delivery team', memberCount: 3, taskCount: 2, mailboxDepth: 2, createdAt: T0 },
          members: [
            { participantId: LEAD, role: 'lead', harnessKind: 'opencode', sessionKey: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJlZWVlZWVlZS1lZWVlLTRlZWUtOGVlZS1lZWVlZWVlZWVlZWUiLCJuYXRpdmU6b3BlbmNvZGUtMSJd', nativeSessionId: 'native:opencode-1' },
            { participantId: W_ACP, role: 'worker', harnessKind: 'acp', sessionKey: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJuYXRpdmU6YWNwLTEiXQ', nativeSessionId: 'native:acp-1' },
            { participantId: W_CODEX, role: 'worker', harnessKind: 'codex', sessionKey: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd', nativeSessionId: 'native:codex-1' },
          ],
          tools: [
            { name: 'delegate', roles: ['lead'] },
            { name: 'status', roles: ['lead', 'worker'] },
            { name: 'message', roles: ['lead', 'worker'] },
            { name: 'evidence', roles: ['lead', 'worker'] },
            { name: 'control', roles: ['lead'] },
          ],
          frozen: { toolTable: true, everyDescriptorFrozen: true, injectionModes: ['native-mcp', 'ui-only'], injectionModesFrozen: true, roles: ['lead', 'worker'], rolesFrozen: true },
          attachments: {
            lead: { mode: 'native-mcp', injectable: true, limitation: null, tools: ['delegate', 'status', 'message', 'evidence', 'control'] },
            acp: { mode: 'ui-only', injectable: false, limitation: UI_LIMITATION, tools: 0 },
            codex: { mode: 'native-mcp', injectable: true, tools: 5 },
          },
          taskAcp: {
            state: 'delegated', workerHarnessKind: 'acp', leadHarnessKind: 'opencode', harnessesDiffer: true,
            delegatedTo: W_ACP, delegatedBy: LEAD, depth: 1, parentId: null, childFailure: 'independent',
            prompt: 'review the bridge runtime', timeoutMs: null, deadlineAt: null,
            criteria: [{ id: 'c1', required: true }],
          },
          taskCodex: {
            state: 'delegated', workerHarnessKind: 'codex', leadHarnessKind: 'opencode', harnessesDiffer: true,
            delegatedTo: W_CODEX, depth: 1, prompt: 'audit the codex transport and report',
          },
          deliverCalls: [
            {
              taskId: taskAcp.taskId, teamId: seed.team.teamId, participantId: W_ACP, harnessKind: 'acp',
              session: { environmentId: ENV_A, harnessInstanceId: H.acp, nativeSessionId: 'native:acp-1' },
              prompt: 'review the bridge runtime',
            },
            {
              taskId: taskCodex.taskId, teamId: seed.team.teamId, participantId: W_CODEX, harnessKind: 'codex',
              session: { environmentId: ENV_A, harnessInstanceId: H.codex, nativeSessionId: 'native:codex-1' },
              prompt: 'audit the codex transport and report',
            },
          ],
          mintedIds: { teamId: true, memberIds: [true, true, true], taskIds: [true, true], distinctMemberIds: 3 },
          used: { concurrency: 2, sessionMutations: 2, depth: 1, children: 0, mailbox: 2 },
          serverState: { tools: 5, nativeCalls: 2, uiCalls: 0, refused: 0, attached: 3, closed: false },
        });
      }

      // ── H2: the lead reads the worker evidence — the deliverable and the review ──
      {
        const world = makeWorld();
        world.server.registerDriver({ harnessKind: 'opencode', toolInjection: { state: 'supported' } });
        world.server.registerDriver({ harnessKind: 'acp', toolInjection: { state: 'supported' } });
        const seed = seedTeam(world, ['acp']);
        world.server.attach({ scope: seed.lead.scope });
        world.server.attach({ scope: seed.workers[0].scope });
        const task = await world.server.call({
          scope: seed.lead.scope, tool: 'delegate',
          params: { title: 'review the bridge runtime', criteria: CRITERION, workerParticipantId: W_ACP, at: T0 },
        });
        // The SAME tool name routes by ROLE: the worker's evidence call SUBMITS...
        const submitted = await world.server.call({
          scope: seed.workers[0].scope, tool: 'evidence',
          params: { taskId: task.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 10 },
        });
        // ...and the lead's evidence call READS. This is the review step of this service: it
        // records the worker's outcome claim and its evidence and deliberately does NOT implement
        // review or acceptance — task 37's acceptance path owns `accepted` (delegationService.js:42-44).
        const read = await world.server.call({
          scope: seed.lead.scope, tool: 'evidence', params: { taskId: task.taskId, at: T0 + 11 },
        });
        check('the lead reads the worker evidence and the OBSERVED content is asserted, not merely that a call succeeded: the worker evidence call SUBMITS through the same tool name and settles the task succeeded with the hash-identified deliverable attached verbatim (deliverableId, the 64-hex artifactHash, bytes and both paths) and endedAt at the submit instant with a null resolution, a null endedBy and a null reason, the lead evidence call READS the very same bytes back frozen at every level, the role routing is structural — the lead scope keys are exactly [control, delegate, message, readEvidence, status] and the worker scope exactly [message, status, submitEvidence], so neither type has a member that reaches the other role operation — and the OBSERVED review step of THIS service is the read-back by the lead: a succeeded worker outcome is a CLAIM with evidence attached, never an acceptance, because this service deliberately implements no review/acceptance state (that is the acceptance path of task 37), so the evidence the lead reviews is exactly the evidence the worker submitted and nothing else moved', {
          submitted: {
            state: submitted.state, evidence: submitted.evidence, endedAt: submitted.endedAt,
            resolution: submitted.resolution, endedBy: submitted.endedBy, reason: submitted.reason,
          },
          read: {
            taskId: read.taskId, evidence: read.evidence,
            frozen: [Object.isFrozen(read), Object.isFrozen(read.evidence), Object.isFrozen(read.evidence[0]), Object.isFrozen(read.evidence[0].paths)],
          },
          evidenceMatchesSubmission: JSON.stringify(submitted.evidence) === JSON.stringify(read.evidence),
          scopeKeys: {
            lead: Object.keys(seed.lead.scope).sort(),
            worker: Object.keys(seed.workers[0].scope).sort(),
            workerHasNoLeadOps: ['delegate', 'control', 'readEvidence'].every((key) => seed.workers[0].scope[key] === undefined),
            leadHasNoSubmit: seed.lead.scope.submitEvidence === undefined,
            frozen: [Object.isFrozen(seed.lead.scope), Object.isFrozen(seed.workers[0].scope)],
          },
          notice: (() => {
            const inbox = world.mailbox.messages({ teamId: seed.team.teamId, participantId: W_ACP });
            return { count: inbox.length, from: inbox[0].from, to: inbox[0].to, text: inbox[0].text, parentMessageId: inbox[0].parentMessageId };
          })(),
          serverState: { ...world.server.state() },
        }, {
          submitted: {
            state: 'succeeded',
            evidence: [{
              deliverableId: 'evidence-bridge-review', artifactHash: 'f'.repeat(64), bytes: 4096,
              paths: ['bridge/runtime/collaboration/delegationService.js', 'app/runtime/delegation.test.ts'],
            }],
            endedAt: T0 + 10, resolution: null, endedBy: null, reason: null,
          },
          read: {
            taskId: task.taskId,
            evidence: [{
              deliverableId: 'evidence-bridge-review', artifactHash: 'f'.repeat(64), bytes: 4096,
              paths: ['bridge/runtime/collaboration/delegationService.js', 'app/runtime/delegation.test.ts'],
            }],
            frozen: [true, true, true, true],
          },
          evidenceMatchesSubmission: true,
          scopeKeys: {
            lead: ['control', 'delegate', 'message', 'readEvidence', 'status'],
            worker: ['message', 'status', 'submitEvidence'],
            workerHasNoLeadOps: true,
            leadHasNoSubmit: true,
            frozen: [true, true],
          },
          notice: {
            count: 1, from: LEAD, to: W_ACP,
            text: `delegated ${task.taskId}: review the bridge runtime`, parentMessageId: null,
          },
          serverState: { tools: 5, nativeCalls: 3, uiCalls: 0, refused: 0, attached: 2, closed: false },
        });
      }
      // ── H3: the message round trip with parent causality through the persistent mailbox ──
      {
        const box = createMailbox();
        const world = makeWorld(undefined, box);
        const seed = seedTeam(world, ['acp', 'codex']);
        const task = await seed.lead.scope.delegate({
          title: 'inspect the dsh adapter', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        // The delegation notice is the FIRST mailbox message, addressed to the worker.
        const acpInboxBefore = box.messages({ teamId: seed.team.teamId, participantId: W_ACP });
        const notice = acpInboxBefore[0];
        const reply = seed.workers[0].scope.message({ to: LEAD, text: 'on it', parentMessageId: notice.messageId, at: T0 + 5 });
        const ping = seed.lead.scope.message({ to: W_CODEX, text: 'status?', at: T0 + 6 });
        const pong = seed.workers[1].scope.message({ to: LEAD, text: 'running', parentMessageId: ping.messageId, at: T0 + 7 });
        // The scope-authorized read: each participant sees ONLY what is addressed to or from it,
        // in the order it was posted.
        const acpInbox = box.messages({ teamId: seed.team.teamId, participantId: W_ACP });
        const codexInbox = box.messages({ teamId: seed.team.teamId, participantId: W_CODEX });
        const leadInbox = box.messages({ teamId: seed.team.teamId, participantId: LEAD });
        const mailboxLimits = { ...MAILBOX_LIMITS };
        // PERSISTENCE: the snapshot round-trips into a FRESH mailbox with parent causality intact.
        const restored = createMailbox();
        const summary = restored.rehydrate(box.snapshot());
        check('the persistent mailbox carries the message round trip with PARENT CAUSALITY and the OBSERVED ordering: the delegation notice is the first message (from the lead, to the worker, its text naming the task, no parent), the worker reply and the lead ping each carry the parentMessageId of the message they answer, and each participant scope-authorized read returns ONLY the messages addressed to or from it in the OBSERVED post order (the acp worker sees its notice then its reply; the codex worker sees its ping then its pong; the lead sees all four in post order) — the team view reports mailboxDepth 4 and the mailbox state reports 4 messages posted exactly once, the frozen MAILBOX_LIMITS row carries the shared mailbox budget by IDENTITY (maxMessages is COLLABORATION_BUDGETS.maxMailbox itself, not a second literal) with this channel own 32 KiB per-message and 128-char participant bounds, and the snapshot rehydrates into a FRESH mailbox re-validating every record — the same participants, the same four messages in the same order, the same parent linkage, the same state and the same depth — so a restart restores the conversation without re-sending anything', {
          notice: { messageId: notice.messageId, from: notice.from, to: notice.to, text: notice.text, parentMessageId: notice.parentMessageId, at: notice.at },
          reply: { messageId: reply.messageId, from: reply.from, to: reply.to, text: reply.text, parentMessageId: reply.parentMessageId, at: reply.at },
          ping: { from: ping.from, to: ping.to, text: ping.text, parentMessageId: ping.parentMessageId },
          pong: { from: pong.from, to: pong.to, text: pong.text, parentMessageId: pong.parentMessageId },
          parentCausality: {
            replyParentsNotice: reply.parentMessageId === notice.messageId,
            pongParentsPing: pong.parentMessageId === ping.messageId,
          },
          acpInbox: { messageIds: acpInbox.map((entry) => entry.messageId), texts: acpInbox.map((entry) => entry.text) },
          codexInbox: { messageIds: codexInbox.map((entry) => entry.messageId), texts: codexInbox.map((entry) => entry.text) },
          leadInbox: { messageIds: leadInbox.map((entry) => entry.messageId), texts: leadInbox.map((entry) => entry.text) },
          team: { ...world.service.team(seed.team.teamId) },
          mailboxState: { ...box.state() },
          limits: mailboxLimits,
          limitsIdentity: mailboxLimits.maxMessages === COLLABORATION_BUDGETS.maxMailbox,
          restored: {
            summary,
            acpInboxEquals: JSON.stringify(restored.messages({ teamId: seed.team.teamId, participantId: W_ACP })) === JSON.stringify(acpInbox),
            codexInboxEquals: JSON.stringify(restored.messages({ teamId: seed.team.teamId, participantId: W_CODEX })) === JSON.stringify(codexInbox),
            leadInboxEquals: JSON.stringify(restored.messages({ teamId: seed.team.teamId, participantId: LEAD })) === JSON.stringify(leadInbox),
            stateEquals: JSON.stringify(restored.state()) === JSON.stringify(box.state()),
            depth: restored.depth(seed.team.teamId),
            replyParentIntact: restored.messages({ teamId: seed.team.teamId, participantId: W_ACP })[1].parentMessageId === notice.messageId,
            frozen: Object.isFrozen(restored.messages({ teamId: seed.team.teamId, participantId: W_ACP })),
          },
        }, {
          notice: { messageId: notice.messageId, from: LEAD, to: W_ACP, text: `delegated ${task.taskId}: inspect the dsh adapter`, parentMessageId: null, at: T0 },
          reply: { messageId: reply.messageId, from: W_ACP, to: LEAD, text: 'on it', parentMessageId: notice.messageId, at: T0 + 5 },
          ping: { from: LEAD, to: W_CODEX, text: 'status?', parentMessageId: null },
          pong: { from: W_CODEX, to: LEAD, text: 'running', parentMessageId: ping.messageId },
          parentCausality: { replyParentsNotice: true, pongParentsPing: true },
          acpInbox: { messageIds: [notice.messageId, reply.messageId], texts: [`delegated ${task.taskId}: inspect the dsh adapter`, 'on it'] },
          codexInbox: { messageIds: [ping.messageId, pong.messageId], texts: ['status?', 'running'] },
          leadInbox: { messageIds: [notice.messageId, reply.messageId, ping.messageId, pong.messageId], texts: [`delegated ${task.taskId}: inspect the dsh adapter`, 'on it', 'status?', 'running'] },
          team: { teamId: seed.team.teamId, name: 'delivery team', memberCount: 3, taskCount: 1, mailboxDepth: 4, createdAt: T0 },
          mailboxState: { teams: 1, participants: 3, messages: 4, posted: 4, closed: false },
          limits: { maxMessages: 1000, maxMessageChars: 32768, maxParticipantChars: 128 },
          limitsIdentity: true,
          restored: {
            summary: { teams: 1, participants: 3, messages: 4 },
            acpInboxEquals: true,
            codexInboxEquals: true,
            leadInboxEquals: true,
            stateEquals: true,
            depth: 4,
            replyParentIntact: true,
            frozen: true,
          },
        });
      }

      // ── H4: a UI-only driver dispatches through the UI by the SAME mechanism ──
      {
        const world = makeWorld();
        world.server.registerDriver({ harnessKind: 'acp', toolInjection: { state: 'unsupported', code: 'unsupported', reason: UI_LIMITATION } });
        world.server.registerDriver({ harnessKind: 'opencode', toolInjection: { state: 'supported' } });
        const seed = seedTeam(world, ['acp', 'codex']);
        const leadAttachment = world.server.attach({ scope: seed.lead.scope });
        const uiOnlyAttachment = world.server.attach({ scope: seed.workers[0].scope });
        // The codex driver was NEVER registered: it fails CLOSED to ui-only with its own explicit
        // limitation rather than inheriting a capability from its kind.
        const failClosedAttachment = world.server.attach({ scope: seed.workers[1].scope });
        const availabilityUiOnly = world.server.availability({ scope: seed.workers[0].scope });
        const availabilityLead = world.server.availability({ scope: seed.lead.scope });
        const availabilityFailClosed = world.server.availability({ scope: seed.workers[1].scope });
        // The native call is refused with the driver's OWN recorded limitation — the tool never
        // pretends to be natively callable.
        const nativeRefusal = await capture(() => world.server.call({ scope: seed.workers[0].scope, tool: 'status', params: {} }));
        // The Host UI path runs the SAME scope checks and the SAME service operations.
        const uiStatus = await world.server.callFromUi({ scope: seed.workers[0].scope, tool: 'status', params: {} });
        const task = await world.server.call({
          scope: seed.lead.scope, tool: 'delegate',
          params: { title: 'review the bridge runtime', criteria: CRITERION, workerParticipantId: W_ACP, at: T0 },
        });
        const uiMessage = await world.server.callFromUi({
          scope: seed.workers[0].scope, tool: 'message',
          params: { to: LEAD, text: 'ui-only worker reporting in', at: T0 + 1 },
        });
        const uiEvidence = await world.server.callFromUi({
          scope: seed.workers[0].scope, tool: 'evidence',
          params: { taskId: task.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 2 },
        });
        // The UI path is a delivery channel, NOT a scope bypass: the role table still refuses.
        const uiDelegateRefusal = await capture(() => world.server.callFromUi({
          scope: seed.workers[0].scope, tool: 'delegate',
          params: { title: 'escape', criteria: CRITERION, workerParticipantId: W_ACP, at: T0 + 3 },
        }));
        check('a UI-only driver dispatches through the UI by the SAME mechanism and the OBSERVED limitation is REAL, never faked: the ui-only driver attaches ZERO scoped tools with its own recorded limitation verbatim and never a fabricated one, an UNREGISTERED driver fails CLOSED to ui-only with the explicit "driver declares no tool-injection support" limitation rather than inheriting a capability from its harness kind, and the truthful availability read model reports nativeCallable FALSE for every one of the five tools with uiDispatchable true and the frozen role table, while the native-mcp lead reports nativeCallable TRUE for all five; a native call for the ui-only driver is refused unsupported/tool_ui_only carrying the real limitation of the driver, and the Host UI path then does the work through the SAME scope checks and the SAME service operations — its status read (no tasks yet, mailbox depth 0), its message to the lead and its evidence submit for the task it was delegated all succeed with the observed state and content, moving uiCalls to 3 while nativeCalls stays at the single delegate of the lead; the UI path is a delivery channel and NOT a scope bypass, so a delegate attempted through it is still refused unauthorized/tool_scope naming the tool and the role, and the server counters observe exactly one refused native call and one refused UI call', {
          leadAttachment: { mode: leadAttachment.mode, toolCount: leadAttachment.tools.length },
          uiOnlyAttachment: { mode: uiOnlyAttachment.mode, injectable: uiOnlyAttachment.injectable, limitation: uiOnlyAttachment.limitation, tools: uiOnlyAttachment.tools.length },
          failClosedAttachment: { mode: failClosedAttachment.mode, injectable: failClosedAttachment.injectable, limitation: failClosedAttachment.limitation, tools: failClosedAttachment.tools.length },
          availabilityUiOnly: {
            mode: availabilityUiOnly.mode, limitation: availabilityUiOnly.limitation,
            tools: availabilityUiOnly.tools.map((tool) => ({ name: tool.name, nativeCallable: tool.nativeCallable, uiDispatchable: tool.uiDispatchable, roles: [...tool.roles] })),
          },
          availabilityLead: {
            mode: availabilityLead.mode,
            allNativeCallable: availabilityLead.tools.every((tool) => tool.nativeCallable),
          },
          availabilityFailClosed: { mode: availabilityFailClosed.mode, limitation: availabilityFailClosed.limitation, anyNativeCallable: availabilityFailClosed.tools.some((tool) => tool.nativeCallable) },
          nativeRefusal,
          uiStatus: { role: uiStatus.role, participantId: uiStatus.participantId, taskCount: uiStatus.tasks.length, mailboxDepth: uiStatus.mailboxDepth },
          task: { state: task.state, delegatedTo: task.delegatedTo },
          uiMessage: { from: uiMessage.from, to: uiMessage.to, text: uiMessage.text, parentMessageId: uiMessage.parentMessageId },
          uiEvidence: { state: uiEvidence.state, evidenceCount: uiEvidence.evidence.length },
          uiDelegateRefusal,
          serverState: { ...world.server.state() },
        }, {
          leadAttachment: { mode: 'native-mcp', toolCount: 5 },
          uiOnlyAttachment: { mode: 'ui-only', injectable: false, limitation: UI_LIMITATION, tools: 0 },
          failClosedAttachment: { mode: 'ui-only', injectable: false, limitation: FAIL_CLOSED_LIMITATION, tools: 0 },
          availabilityUiOnly: {
            mode: 'ui-only', limitation: UI_LIMITATION,
            tools: [
              { name: 'delegate', nativeCallable: false, uiDispatchable: true, roles: ['lead'] },
              { name: 'status', nativeCallable: false, uiDispatchable: true, roles: ['lead', 'worker'] },
              { name: 'message', nativeCallable: false, uiDispatchable: true, roles: ['lead', 'worker'] },
              { name: 'evidence', nativeCallable: false, uiDispatchable: true, roles: ['lead', 'worker'] },
              { name: 'control', nativeCallable: false, uiDispatchable: true, roles: ['lead'] },
            ],
          },
          availabilityLead: { mode: 'native-mcp', allNativeCallable: true },
          availabilityFailClosed: { mode: 'ui-only', limitation: FAIL_CLOSED_LIMITATION, anyNativeCallable: false },
          nativeRefusal: { code: 'unsupported', field: 'tool_ui_only' },
          uiStatus: { role: 'worker', participantId: W_ACP, taskCount: 0, mailboxDepth: 0 },
          task: { state: 'delegated', delegatedTo: W_ACP },
          uiMessage: { from: W_ACP, to: LEAD, text: 'ui-only worker reporting in', parentMessageId: null },
          uiEvidence: { state: 'succeeded', evidenceCount: 1 },
          uiDelegateRefusal: { code: 'unauthorized', field: 'tool_scope' },
          serverState: { tools: 5, nativeCalls: 1, uiCalls: 3, refused: 2, attached: 3, closed: false },
        });
      }
      // ── H5: every command the case lists is actually STARTED or CHECKED ──
      {
        const world = makeWorld();
        world.server.registerDriver({ harnessKind: 'opencode', toolInjection: { state: 'supported' } });
        world.server.registerDriver({ harnessKind: 'acp', toolInjection: { state: 'unsupported', code: 'unsupported', reason: UI_LIMITATION } });
        world.server.registerDriver({ harnessKind: 'codex', toolInjection: { state: 'supported' } });
        const trace = [];
        const team = world.service.createTeam({ name: 'delivery team', at: T0 });
        trace.push({ command: 'createTeam', memberCount: team.memberCount, taskCount: team.taskCount, mailboxDepth: team.mailboxDepth, createdAt: team.createdAt });
        const leadJoin = world.service.addMember({ teamId: team.teamId, participantId: LEAD, role: 'lead', harnessKind: 'opencode', session: SESSIONS.opencode, at: T0 });
        trace.push({ command: 'addMember(lead)', role: leadJoin.member.role, harnessKind: leadJoin.member.harnessKind, scopeKeys: Object.keys(leadJoin.scope).sort() });
        const acpJoin = world.service.addMember({ teamId: team.teamId, participantId: W_ACP, role: 'worker', harnessKind: 'acp', session: SESSIONS.acp, at: T0 });
        trace.push({ command: 'addMember(acp worker)', role: acpJoin.member.role, harnessKind: acpJoin.member.harnessKind, scopeKeys: Object.keys(acpJoin.scope).sort() });
        const codexJoin = world.service.addMember({ teamId: team.teamId, participantId: W_CODEX, role: 'worker', harnessKind: 'codex', session: SESSIONS.codex, at: T0 });
        trace.push({ command: 'addMember(codex worker)', role: codexJoin.member.role, harnessKind: codexJoin.member.harnessKind, scopeKeys: Object.keys(codexJoin.scope).sort() });
        const leadAttach = world.server.attach({ scope: leadJoin.scope });
        trace.push({ command: 'attach(lead native-mcp)', mode: leadAttach.mode, toolNames: leadAttach.tools.map((tool) => tool.name) });
        const acpAttach = world.server.attach({ scope: acpJoin.scope });
        trace.push({ command: 'attach(acp worker ui-only)', mode: acpAttach.mode, toolCount: acpAttach.tools.length, limitation: acpAttach.limitation });
        const codexAttach = world.server.attach({ scope: codexJoin.scope });
        trace.push({ command: 'attach(codex worker native-mcp)', mode: codexAttach.mode, toolCount: codexAttach.tools.length });
        const taskAcp = await world.server.call({
          scope: leadJoin.scope, tool: 'delegate',
          params: { title: 'review the bridge runtime', criteria: CRITERION, workerParticipantId: W_ACP, at: T0 + 1 },
        });
        trace.push({ command: 'delegate(lead native -> acp)', state: taskAcp.state, workerHarnessKind: taskAcp.workerHarnessKind, deliverCalls: world.counters.deliver });
        const taskCodex = await world.server.call({
          scope: leadJoin.scope, tool: 'delegate',
          params: { title: 'audit the codex transport', criteria: CRITERION, workerParticipantId: W_CODEX, prompt: 'audit the codex transport and report', at: T0 + 2 },
        });
        trace.push({ command: 'delegate(lead native -> codex)', state: taskCodex.state, workerHarnessKind: taskCodex.workerHarnessKind, prompt: taskCodex.prompt, deliverCalls: world.counters.deliver });
        const submitted = await world.server.callFromUi({
          scope: acpJoin.scope, tool: 'evidence',
          params: { taskId: taskAcp.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 3 },
        });
        trace.push({ command: 'evidence submit(acp ui-only via UI)', state: submitted.state, evidenceCount: submitted.evidence.length });
        const read = await world.server.call({ scope: leadJoin.scope, tool: 'evidence', params: { taskId: taskAcp.taskId, at: T0 + 4 } });
        trace.push({ command: 'evidence read(lead native)', taskId: read.taskId, deliverableId: read.evidence[0].deliverableId });
        const statusLead = await world.server.call({ scope: leadJoin.scope, tool: 'status', params: {} });
        trace.push({ command: 'status(lead native)', role: statusLead.role, taskCount: statusLead.tasks.length, taskStates: statusLead.tasks.map((entry) => entry.state), mailboxDepth: statusLead.mailboxDepth });
        const statusCodex = await world.server.call({ scope: codexJoin.scope, tool: 'status', params: {} });
        trace.push({ command: 'status(codex worker native)', role: statusCodex.role, taskCount: statusCodex.tasks.length, mailboxDepth: statusCodex.mailboxDepth });
        const ping = await world.server.call({ scope: leadJoin.scope, tool: 'message', params: { to: W_CODEX, text: 'status?', at: T0 + 5 } });
        trace.push({ command: 'message(lead native -> codex)', from: ping.from, to: ping.to, parentMessageId: ping.parentMessageId });
        const pong = await world.server.call({ scope: codexJoin.scope, tool: 'message', params: { to: LEAD, text: 'running', parentMessageId: ping.messageId, at: T0 + 6 } });
        trace.push({ command: 'message(codex native -> lead)', from: pong.from, to: pong.to, parentIsPing: pong.parentMessageId === ping.messageId });
        const cancel = await world.server.call({ scope: leadJoin.scope, tool: 'control', params: { taskId: taskCodex.taskId, action: 'cancel', reason: 'lead cancelled', at: T0 + 7 } });
        trace.push({ command: 'control(lead native cancel)', action: cancel.action, count: cancel.count, transitioned: cancel.transitioned.length, skipped: cancel.skipped.length });
        const sweep = world.service.sweep({ at: T0 + 8 });
        trace.push({ command: 'sweep', count: sweep.count, timedOut: sweep.timedOut.length });
        const reconcile = world.service.reconcile({ at: T0 + 9 });
        trace.push({ command: 'reconcile', retained: reconcile.retained.length, dispatched: reconcile.dispatched.length });
        const budgets = world.service.budgets();
        trace.push({ command: 'budgets', used: { ...budgets.used }, limitsAreSharedObject: budgets.limits === COLLABORATION_BUDGETS });
        const finalState = world.service.state();
        trace.push({ command: 'state', ...finalState });
        const taskRead = world.service.task(taskAcp.taskId);
        trace.push({ command: 'task(taskId)', state: taskRead.state, evidenceCount: taskRead.evidence.length });
        const tasksRead = world.service.tasks(team.teamId);
        trace.push({ command: 'tasks(teamId)', count: tasksRead.length, states: tasksRead.map((entry) => entry.state) });
        const teamRead = world.service.team(team.teamId);
        trace.push({ command: 'team(teamId)', memberCount: teamRead.memberCount, taskCount: teamRead.taskCount, mailboxDepth: teamRead.mailboxDepth });
        const teamsRead = world.service.teams();
        trace.push({ command: 'teams()', count: teamsRead.length });
        const memberRead = world.service.member(leadJoin.member.memberId);
        trace.push({ command: 'member(memberId)', role: memberRead.role, harnessKind: memberRead.harnessKind });
        const membersRead = world.service.members(team.teamId);
        trace.push({ command: 'members(teamId)', count: membersRead.length, roles: membersRead.map((entry) => entry.role) });
        const mailboxRead = world.mailbox.messages({ teamId: team.teamId, participantId: W_CODEX });
        trace.push({ command: 'mailbox.messages(codex worker)', count: mailboxRead.length, texts: mailboxRead.map((entry) => entry.text) });
        const toolsRead = world.server.tools();
        trace.push({ command: 'tools()', count: toolsRead.length, names: toolsRead.map((tool) => tool.name) });
        const serverState = world.server.state();
        trace.push({ command: 'server.state()', ...serverState });
        check('every command of the Lead/Worker surface is actually STARTED and its effect CHECKED, in one chronological trace over one world — no command is merely enumerated: createTeam mints an empty team, the three addMember calls mint the lead and the two workers each with its OWN role scope (the lead keys are the five lead operations, each worker keys the three worker operations), attach gives the native-mcp lead and codex worker their five temporary scoped tools and the ui-only acp worker none with its real limitation, the two native delegate calls of the lead create one task per worker with the deliver port observed at 1 then 2, the acp worker evidence submit travels the UI channel while the evidence read of the lead travels the native channel, the status of the lead sees both team tasks (one succeeded, one delegated) at mailbox depth 2 while the codex worker status sees only its own task, the message round trip posts a lead ping and a codex pong parented to it, the cancel by the lead transitions exactly the codex task (count 1, skipped 0), the sweep then finds nothing to retire and the reconcile retains nothing because every task is already terminal, the budgets read model reports the used counts with the limits object being the SHARED frozen object itself, the state counters report one succeeded and one cancelled with nothing in flight, and every read model — task, tasks, team, teams, member, members, mailbox.messages, tools and the tool server state — is read back over the same world with the observed values, so all twenty-nine commands were executed, not listed', {
          trace,
          traceLength: trace.length,
          commands: trace.map((entry) => entry.command),
        }, {
          trace: [
            { command: 'createTeam', memberCount: 0, taskCount: 0, mailboxDepth: 0, createdAt: T0 },
            { command: 'addMember(lead)', role: 'lead', harnessKind: 'opencode', scopeKeys: ['control', 'delegate', 'message', 'readEvidence', 'status'] },
            { command: 'addMember(acp worker)', role: 'worker', harnessKind: 'acp', scopeKeys: ['message', 'status', 'submitEvidence'] },
            { command: 'addMember(codex worker)', role: 'worker', harnessKind: 'codex', scopeKeys: ['message', 'status', 'submitEvidence'] },
            { command: 'attach(lead native-mcp)', mode: 'native-mcp', toolNames: ['delegate', 'status', 'message', 'evidence', 'control'] },
            { command: 'attach(acp worker ui-only)', mode: 'ui-only', toolCount: 0, limitation: UI_LIMITATION },
            { command: 'attach(codex worker native-mcp)', mode: 'native-mcp', toolCount: 5 },
            { command: 'delegate(lead native -> acp)', state: 'delegated', workerHarnessKind: 'acp', deliverCalls: 1 },
            { command: 'delegate(lead native -> codex)', state: 'delegated', workerHarnessKind: 'codex', prompt: 'audit the codex transport and report', deliverCalls: 2 },
            { command: 'evidence submit(acp ui-only via UI)', state: 'succeeded', evidenceCount: 1 },
            { command: 'evidence read(lead native)', taskId: taskAcp.taskId, deliverableId: 'evidence-bridge-review' },
            { command: 'status(lead native)', role: 'lead', taskCount: 2, taskStates: ['succeeded', 'delegated'], mailboxDepth: 2 },
            { command: 'status(codex worker native)', role: 'worker', taskCount: 1, mailboxDepth: 2 },
            { command: 'message(lead native -> codex)', from: LEAD, to: W_CODEX, parentMessageId: null },
            { command: 'message(codex native -> lead)', from: W_CODEX, to: LEAD, parentIsPing: true },
            { command: 'control(lead native cancel)', action: 'cancel', count: 1, transitioned: 1, skipped: 0 },
            { command: 'sweep', count: 0, timedOut: 0 },
            { command: 'reconcile', retained: 0, dispatched: 0 },
            { command: 'budgets', used: { concurrency: 0, sessionMutations: 0, depth: 1, children: 0, mailbox: 4 }, limitsAreSharedObject: true },
            { command: 'state', teams: 1, members: 3, tasks: 2, inFlight: 0, succeeded: 1, failed: 0, cancelled: 1, timeouts: 0, ambiguous: 0, reconciles: 0, closed: false },
            { command: 'task(taskId)', state: 'succeeded', evidenceCount: 1 },
            { command: 'tasks(teamId)', count: 2, states: ['succeeded', 'cancelled'] },
            { command: 'team(teamId)', memberCount: 3, taskCount: 2, mailboxDepth: 4 },
            { command: 'teams()', count: 1 },
            { command: 'member(memberId)', role: 'lead', harnessKind: 'opencode' },
            { command: 'members(teamId)', count: 3, roles: ['lead', 'worker', 'worker'] },
            { command: 'mailbox.messages(codex worker)', count: 3, texts: [`delegated ${taskCodex.taskId}: audit the codex transport`, 'status?', 'running'] },
            { command: 'tools()', count: 5, names: ['delegate', 'status', 'message', 'evidence', 'control'] },
            { command: 'server.state()', tools: 5, nativeCalls: 8, uiCalls: 1, refused: 0, attached: 3, closed: false },
          ],
          traceLength: 29,
          commands: [
            'createTeam', 'addMember(lead)', 'addMember(acp worker)', 'addMember(codex worker)',
            'attach(lead native-mcp)', 'attach(acp worker ui-only)', 'attach(codex worker native-mcp)',
            'delegate(lead native -> acp)', 'delegate(lead native -> codex)',
            'evidence submit(acp ui-only via UI)', 'evidence read(lead native)',
            'status(lead native)', 'status(codex worker native)',
            'message(lead native -> codex)', 'message(codex native -> lead)',
            'control(lead native cancel)', 'sweep', 'reconcile', 'budgets', 'state',
            'task(taskId)', 'tasks(teamId)', 'team(teamId)', 'teams()', 'member(memberId)', 'members(teamId)',
            'mailbox.messages(codex worker)', 'tools()', 'server.state()',
          ],
        });
      }
      // ── H6: cascade cancel and the timeout sweep ──
      {
        const world = makeWorld();
        const seed = seedTeam(world, ['acp', 'codex', 'kimi-web']);
        const root = await seed.lead.scope.delegate({
          title: 'root', criteria: CRITERION, workerParticipantId: W_ACP, at: T0,
        });
        const child = await seed.lead.scope.delegate({
          title: 'child', criteria: CRITERION, workerParticipantId: W_CODEX, parentTaskId: root.taskId, at: T0 + 1,
        });
        const grandchild = await seed.lead.scope.delegate({
          title: 'grandchild', criteria: CRITERION, workerParticipantId: W_KIMI, parentTaskId: child.taskId, at: T0 + 2,
        });
        const cancelled = seed.lead.scope.control({ taskId: root.taskId, action: 'cancel', reason: 'lead cancelled', at: T0 + 100 });
        const cancelledAgain = seed.lead.scope.control({ taskId: root.taskId, action: 'cancel', at: T0 + 200 });
        // The in-flight count is read HERE, at the moment the assertion describes it: the cascade
        // cancel has just released every one of the three slots. Reading it again inside the check
        // block would observe the LATER delegations below (the independent parent is deliberately
        // left delegated), which is a different moment, not a different product behaviour.
        const inFlightAfterCascadeCancel = world.service.state().inFlight;
        // A child failure cascades UP only through a parent whose RECORDED policy is `cascade`.
        const cascading = await seed.lead.scope.delegate({
          title: 'cascading parent', criteria: CRITERION, workerParticipantId: W_ACP, childFailure: 'cascade', at: T0 + 10,
        });
        const cascadingChild = await seed.lead.scope.delegate({
          title: 'cascading child', criteria: CRITERION, workerParticipantId: W_CODEX, parentTaskId: cascading.taskId, at: T0 + 11,
        });
        const cascadedFailure = seed.workers[1].scope.submitEvidence({
          taskId: cascadingChild.taskId, outcome: 'failed', reason: 'worker could not compile', evidence: [EVIDENCE], at: T0 + 12,
        });
        const independent = await seed.lead.scope.delegate({
          title: 'independent parent', criteria: CRITERION, workerParticipantId: W_KIMI, childFailure: 'independent', at: T0 + 20,
        });
        const independentChild = await seed.lead.scope.delegate({
          title: 'independent child', criteria: CRITERION, workerParticipantId: W_ACP, parentTaskId: independent.taskId, childFailure: 'independent', at: T0 + 21,
        });
        const independentFailure = seed.workers[0].scope.submitEvidence({
          taskId: independentChild.taskId, outcome: 'failed', reason: 'worker could not compile', evidence: [EVIDENCE], at: T0 + 22,
        });
        // The timeout sweep retires a delegation whose worker never reports.
        const timeoutWorld = makeWorld();
        const timeoutSeed = seedTeam(timeoutWorld, ['acp', 'codex']);
        const slow = await timeoutSeed.lead.scope.delegate({
          title: 'slow work', criteria: CRITERION, workerParticipantId: W_ACP, timeoutMs: 5000, at: T0,
        });
        const beforeDeadline = timeoutWorld.service.sweep({ at: T0 + 4999 });
        // Read HERE, at the moment the assertion names it: "nothing at T0+4999 with the task still
        // delegated". The sweep at T0+5000 below mutates the SAME record, so re-reading the state
        // inside the check block would observe the post-sweep value and silently test nothing.
        const stateBeforeDeadline = timeoutWorld.service.task(slow.taskId).state;
        const atDeadline = timeoutWorld.service.sweep({ at: T0 + 5000 });
        check('cascade cancel and the timeout sweep are OBSERVED terminating with the real counts: a cancel on the root cascades DOWN the whole subtree breadth-first (count 3, transitioned [root, child, grandchild], skipped empty) settling every level cancelled with the cancelling ancestor recorded in endedBy and resolution cancelled/delegation_cancel, and a second cancel transitions nothing while reporting all three already-settled tasks in skipped with inFlight back to 0; a child failure cascades UP only through the parent whose childFailure policy was RECORDED as cascade at delegate time (the parent settles failed with endedBy naming the child and the child-failed action, the typed resolution and the reason verbatim) while the independent parent stays delegated with endedBy null, so the walk is bounded by the depth-4 limit and always terminates; and the timeout sweep retires a delegation whose deadline has passed — nothing at T0+4999 with the task still delegated, exactly the one task at T0+5000 with state timeout, endedBy recording the timeout action and resolution timeout/delegation_timeout — leaving nothing in flight, so every path reached a terminal state and none hung', {
          cascadeCancel: {
            action: cancelled.action, count: cancelled.count,
            transitioned: cancelled.transitioned.map((taskId) => taskId),
            skipped: cancelled.skipped,
            settled: cancelled.transitioned.map((taskId) => {
              const view = world.service.task(taskId);
              return { taskId, state: view.state, endedBy: { ...view.endedBy }, resolution: { ...view.resolution }, endedAt: view.endedAt, reason: view.reason };
            }),
            again: { count: cancelledAgain.count, transitioned: cancelledAgain.transitioned, skipped: cancelledAgain.skipped },
            inFlight: inFlightAfterCascadeCancel,
          },
          childFailureCascade: {
            failed: { state: cascadedFailure.state, resolution: { ...cascadedFailure.resolution }, reason: cascadedFailure.reason },
            parent: (() => {
              const view = world.service.task(cascading.taskId);
              return { state: view.state, endedBy: { ...view.endedBy }, resolution: { ...view.resolution } };
            })(),
            independentChild: { state: independentFailure.state },
            independentParent: (() => {
              const view = world.service.task(independent.taskId);
              return { state: view.state, endedBy: view.endedBy };
            })(),
          },
          timeoutSweep: {
            deadlineAt: slow.deadlineAt, timeoutMs: slow.timeoutMs,
            beforeDeadline: { count: beforeDeadline.count, timedOut: beforeDeadline.timedOut },
            stateBeforeDeadline,
            atDeadline: { count: atDeadline.count, timedOut: atDeadline.timedOut },
            settled: (() => {
              const view = timeoutWorld.service.task(slow.taskId);
              return { state: view.state, endedBy: { ...view.endedBy }, resolution: { ...view.resolution } };
            })(),
            inFlight: timeoutWorld.service.state().inFlight,
          },
        }, {
          cascadeCancel: {
            action: 'cancel', count: 3,
            transitioned: [root.taskId, child.taskId, grandchild.taskId],
            skipped: [],
            settled: [root.taskId, child.taskId, grandchild.taskId].map((taskId) => ({
              taskId,
              state: 'cancelled',
              endedBy: { taskId: root.taskId, action: 'cancel', at: T0 + 100 },
              resolution: { code: 'cancelled', field: 'delegation_cancel' },
              endedAt: T0 + 100,
              reason: 'lead cancelled',
            })),
            again: { count: 0, transitioned: [], skipped: [root.taskId, child.taskId, grandchild.taskId] },
            inFlight: 0,
          },
          childFailureCascade: {
            failed: { state: 'failed', resolution: { code: 'delegation_failed', field: 'delegation_outcome' }, reason: 'worker could not compile' },
            parent: {
              state: 'failed',
              endedBy: { taskId: cascadingChild.taskId, action: 'child-failed', at: T0 + 12 },
              // The CASCADED parent carries the cascade resolution, which is NOT the child's own
              // outcome resolution: cascadeUp settles delegation_failed/delegation_child_failure.
              resolution: { code: 'delegation_failed', field: 'delegation_child_failure' },
            },
            independentChild: { state: 'failed' },
            independentParent: { state: 'delegated', endedBy: null },
          },
          timeoutSweep: {
            deadlineAt: T0 + 5000, timeoutMs: 5000,
            beforeDeadline: { count: 0, timedOut: [] },
            stateBeforeDeadline: 'delegated',
            atDeadline: { count: 1, timedOut: [slow.taskId] },
            settled: {
              state: 'timeout',
              endedBy: { taskId: slow.taskId, action: 'timeout', at: T0 + 5000 },
              resolution: { code: 'timeout', field: 'delegation_timeout' },
            },
            inFlight: 0,
          },
        });
      }
    }

    // ── every observed rejection code is a member of the frozen table, in BOTH realms ──
    const observedCodeList = [...observedCodes].sort();
    // The expected set is DERIVED FROM WHAT THE PRODUCT ACTUALLY EMITS in this lane (driven against
    // the real modules, not assumed). The happy lane is NOT invalid_request-only: its parser-boundary
    // refusals contribute invalid_request and one conflict (duplicate criteria ids), and H4 drives two
    // tool-server refusals of its own — a native call on a ui-only driver (unsupported/tool_ui_only) and
    // a delegate attempted through the UI delivery channel (unauthorized/tool_scope). Pinning the real
    // four keeps the check an EXACT-set assertion (observedCount === distinctObserved === this length,
    // every code in the frozen table, missing empty), never a loosened "at least one".
    const expectedCodeList = context.case === 'failure'
      ? ['cancelled', 'conflict', 'invalid_request', 'unauthorized']
      : ['conflict', 'invalid_request', 'unauthorized', 'unsupported'];
    const workerMembership = {
      observedCount: observedCodeList.length,
      missing: observedCodeList.filter((code) => !ERROR_CODES.includes(code)),
      allObservedCodesInTable: observedCodeList.every((code) => ERROR_CODES.includes(code)),
      distinctObserved: new Set(observedCodeList).size,
    };
    await crossRealm('every rejection code the product actually emitted across this lane belongs to the frozen canonical ERROR_CODES table, checked in BOTH realms — the browser recomputing the membership over the exact list the worker collected — with none missing and the distinct count recorded, so no observed rejection can travel outside the frozen table (the failure lane emits cancelled, conflict, invalid_request and unauthorized; the happy lane emits conflict, invalid_request, unauthorized and unsupported — the invalid_request and conflict from the parser-boundary refusals recomputed in the contract table, the unauthorized from a delegate attempted through the UI delivery channel, and the unsupported from a native call on a ui-only driver)', workerMembership, await evaluate((list) => window.task39.codeMembership(list), observedCodeList), {
      observedCount: expectedCodeList.length,
      missing: [],
      allObservedCodesInTable: true,
      distinctObserved: expectedCodeList.length,
    });

    // ── the browser realm ran clean ──
    check('the browser realm ran the whole cross-realm half with zero page errors and zero unhandled rejections — recorded by BOTH the own listener of the browser entry and the harness-level page listener — and its DOM host still carries the last printed payload, so the agreement of the second realm with the worker is not the artefact of a silently failed module', {
      entryErrors: await evaluate(() => window.task39.errors()),
      pageErrors: await evaluate(() => window.__task39Errors ?? []),
      domNonEmpty: (await evaluate(() => window.task39.domText())).length > 0,
    }, { entryErrors: [], pageErrors: [], domNonEmpty: true });

    // ── the visual evidence of the cross-realm half ──
    // The omowright page wrapper exposes NO setViewportSize — OmOPage.prototype carries only
    // viewportSize / refreshViewportSize / setCachedViewportSize (read/cache), verified by driving
    // the wrapper. Its REAL viewport control is the module-level omowright.emulate(page, {...})
    // driving CDP Emulation.setDeviceMetricsOverride — the exact call tasks 34-38 use to shoot two
    // widths (the twenty-ninth-instance lesson: a value was passed to a receiver whose contract was
    // assumed, not checked). A desktop 1440x900 and a phone 390x844, each captured to its own
    // artifact; nothing here is faked — emulate is the wrapper's own exported function.
    await omowright.emulate(page, { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
    await page.screenshot({ path: path.join(runDir, 'final-1440.png') });
    await omowright.emulate(page, { width: 390, height: 844, deviceScaleFactor: 1, mobile: false, hasTouch: false });
    await page.screenshot({ path: path.join(runDir, 'final-390.png') });
    const domText = await evaluate(() => window.task39.domText());
    await writeFile(path.join(runDir, 'dom-trace-1440.txt'), domText, 'utf8');
    await writeFile(path.join(runDir, 'dom-trace-390.txt'), domText, 'utf8');
    await writeFile(path.join(runDir, 'protocol.json'), `${JSON.stringify(protocol, null, 2)}\n`, 'utf8');
    artifacts.push(
      artifact(path.join(runDir, 'final-1440.png'), 'screenshot'),
      artifact(path.join(runDir, 'final-390.png'), 'screenshot'),
      artifact(path.join(runDir, 'dom-trace-1440.txt'), 'dom-trace'),
      artifact(path.join(runDir, 'dom-trace-390.txt'), 'dom-trace'),
      artifact(path.join(runDir, 'protocol.json'), 'case-protocol'),
    );

    // ── boundedness, read from the product's OWN counters ──
    // state() and the mailbox state() do NOT assert open (verified in F5), so they stay readable
    // after a world was closed; teams()/members() DO assert open, so a closed world contributes
    // its counters but not its team walk.
    const harnessKindsUsed = [...new Set(worlds
      .filter((world) => world.service.state().closed === false)
      .flatMap((world) => world.service.teams().flatMap((team) => world.service.members(team.teamId).map((view) => view.harnessKind))))].sort();
    const totalTasks = worlds.reduce((sum, world) => sum + world.service.state().tasks, 0);
    const largestMailbox = worlds.reduce((max, world) => Math.max(max, world.mailbox.state().messages), 0);
    const resourceCount = fixture.resources.length;
    // Captured ONCE, into locals, and the SAME values used on both sides of the assertion: a
    // heapUsed reading is a GC-timing artefact, so re-reading it for the expected side would
    // compare two different measurements and could fail spuriously.
    const heapGrowth = process.memoryUsage().heapUsed - heapStart;
    const heapPeakGrowth = peakHeap - heapStart;
    check('the case is bounded by the OWN read models of the product and its own ledger: it created a finite number of teams, members and delegations whose largest team mailbox never exceeds the frozen 1000-message budget, it exercised all five harness kinds of this plan (opencode, codex, acp, kimi-web, dsh), it spawned ZERO external processes (no harness, no SSH host, no Slurm client — the browser and the Vite server are the only owned processes and both are in the ledger), its heap growth stayed far inside the 256 MiB bound, and every transient resource it created was registered in the ledger BEFORE it was created', {
      spawnCalls: 0,
      worlds: worlds.length,
      delegationsCreated: totalTasks,
      largestMailboxMessages: largestMailbox,
      largestWithinFrozenLimit: largestMailbox <= COLLABORATION_BUDGETS.maxMailbox,
      distinctHarnessKinds: harnessKindsUsed,
      ownedResourcesRegistered: resourceCount > 0,
      heapGrowthBytes: heapGrowth,
      heapPeakGrowthBytes: heapPeakGrowth,
      heapWithinBound: heapPeakGrowth < HEAP_BOUND,
    }, {
      spawnCalls: 0,
      worlds: worlds.length,
      delegationsCreated: totalTasks,
      largestMailboxMessages: largestMailbox,
      largestWithinFrozenLimit: true,
      distinctHarnessKinds: ['acp', 'codex', 'dsh', 'kimi-web', 'opencode'],
      ownedResourcesRegistered: true,
      heapGrowthBytes: heapGrowth,
      heapPeakGrowthBytes: heapPeakGrowth,
      heapWithinBound: true,
    });
    record('boundedness', {
      worlds: worlds.length, delegationsCreated: totalTasks, largestMailboxMessages: largestMailbox,
      harnessKindsUsed, ownedResourcesRegistered: resourceCount,
      heapGrowthBytes: process.memoryUsage().heapUsed - heapStart, heapPeakGrowthBytes: peakHeap - heapStart,
    });

    // ── the authored files and the pinned product bytes did not move ──
    const sourceAfter = sourceSnapshot(context.root, ownedFiles);
    const productHashesAfter = productHashes(context.root);
    check('the evidence binds to the CURRENT bytes: the three case-owned files hash IDENTICALLY before and after the whole run (zero differing files), the seven pinned product files — the four landed collaboration modules, the product own delegation suite and the frozen shared contract — hash identically before and after with every digest a well-formed 64-hex sha256, and the recorded digests are the ones the sourceHashes of the artifact carry, so a green report cannot be a report against different bytes', {
      authoredFileCount: ownedFiles.length,
      differingFiles: ownedFiles.filter((file) => sourceBefore[file] !== sourceAfter[file]).length,
      pinnedSources: Object.keys(sourceFiles).length,
      ownedResourceCount: resourceCount > 0,
      pinnedProductFileCount: PRODUCT_FILES.length,
      productHashesMatch: JSON.stringify(productHashesBefore) === JSON.stringify(productHashesAfter),
      allSha256Shaped: Object.values(productHashesAfter).every((hash) => /^[\da-f]{64}$/.test(hash)),
      productDigests: productHashesAfter,
    }, {
      authoredFileCount: 3,
      differingFiles: 0,
      pinnedSources: sourceFiles.length,
      ownedResourceCount: true,
      pinnedProductFileCount: 7,
      productHashesMatch: true,
      allSha256Shaped: true,
      productDigests: productHashesBefore,
    });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task39Errors ?? [], task39: Boolean(window.task39) })).catch((value) => ({ unavailable: String(value) }));
      await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => undefined);
    }
    persist();
    throw error;
  } finally {
    const closed = await fixture.close().catch((error) => ({ error: String(error) }));
    proof.cleanup = closed;
    persist();
    artifacts.push(artifact(path.join(runDir, 'proof.json'), 'registered-case-proof'), artifact(path.join(runDir, 'resources.json'), 'resource-ledger'));
  }

  return {
    scenarios,
    artifacts,
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'lead-worker-delegation-team-tools-and-messages', schema: 'runtime-collaboration-delegation/v1' },
    cleanup: proof.cleanup,
    defects: [
      { id: 'budgetRefusalsAreRefusalsNotParks', kind: 'observation', detail: 'the coordination budget gate REFUSES with real counts (a 33rd child or a depth-5 link is never created at all) rather than parking visibly, which is the deliberate task-39 design recorded in the implementation risks: budgets() remains the visible used-vs-limit display. OBSERVED AND RECORDED, NOT FORCED.' },
      { id: 'successIsAClaimNotAcceptance', kind: 'observation', detail: "a worker's succeeded is a CLAIM with evidence attached, never an acceptance: this service deliberately implements no review/acceptance state (delegationService.js:42-44 says so in its own header) and task 37's acceptance path owns `accepted`. The plan happy criterion's review step is therefore OBSERVED as the lead's readEvidence read-back, not as an acceptance transition." },
      { id: 'uiOnlyLimitationIsReal', kind: 'observation', detail: 'the availability read model never reports a nativeCallable tool a ui-only driver does not hold, and an unregistered driver fails CLOSED to ui-only with the explicit "driver declares no tool-injection support" limitation — a capability is never inferred from a harness kind (the harnessContract doctrine).' },
      { id: 'resolveScopeAndDepthDoNotAssertOpen', kind: 'observation', detail: 'after close, resolveScope and the mailbox depth do not call assertOpen: they read the already-cleared maps and refuse invalid_request/delegation_scope and invalid_request/mailbox_team instead of cancelled/*_closed. Recorded rather than forced.' },
      { id: 'deliverPortIsADeterministicDouble', kind: 'boundary', detail: 'the deliver prompt port is the one seam the product own signature declares (delegationService.js:185) and is backed by a counting, recording fake: the cross-harness delegation, the verbatim prompt, the typed source error, the plain-Error classification and the unreadable-outcome stop are all observed at that sink boundary. No live opencode, codex, kimi-web, dsh or acp backend is contacted.' },
      { id: 'durabilityAcrossProcessDeathNotClaimed', kind: 'boundary', detail: 'the mailbox snapshot/rehydrate round trip is proven IN-PROCESS over the real module; no real process death is exercised and none is claimed (task 34/37/38 posture). The single-writer durable store is task 8 surface.' },
      { id: 'collaborationUiNotExercised', kind: 'boundary', detail: 'no rendered collaboration UI is claimed (task 42 owns it). The UI-only criterion is satisfied by driving the product OWN tool server and capability model: callFromUi runs the SAME scope checks and the SAME service operations, and the availability read model reports the real limitation.' },
      { id: 'liveHarnessAndRemoteSurfacesNotExercised', kind: 'boundary', detail: 'the five harness kinds appear as member identities and capability declarations only; no live multi-harness run, no live SSH and no live Slurm verification (task 46 owns end-to-end).' },
    ],
    evidenceBoundary: 'The stateful bridge services cannot enter the browser realm at all (all four product modules import node:crypto on line 1), so teams, members, scopes, delegate, evidence, messages, control, sweep, reconcile, the temporary scoped tools and the UI dispatch path are proven in the Node worker over the real modules; the browser realm proves the frozen shared contract, the canonical session keys and the id/shape parsers, recomputed from the same pure modules and asserted equal to the worker values. The deliver prompt port is a deterministic double at the unit boundary. No durability across a real process death, no live multi-harness run, no live SSH or Slurm, and no rendered collaboration UI is claimed. No PASS verdict is authored here; the runner writes the artifact and the independent gate judges it.',
  };
}

