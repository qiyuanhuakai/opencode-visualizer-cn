// @vitest-environment node
//
// Task 39 — Lead/Worker delegation, the Team tool contract and member messages.
//
// Product under test:
//   bridge/runtime/collaboration/toolCapabilities.js  (per-driver tool-injection detection +
//                                                    the temporary scoped-tool registration)
//   bridge/runtime/collaboration/mailbox.js           (persistent bidirectional participant mailbox)
//   bridge/runtime/collaboration/delegationService.js (Lead/Worker, delegate/evidence/control)
//   bridge/runtime/collaboration/toolServer.js        (the five standard tools + UI-only truth)
//   shared/runtime/collaboration.js                   (the frozen contract: budgets, parsers)
//
// The four bridge modules under test are loaded through createRequire rather than a static import:
// this task's grant is exactly five new paths and none of them is a declaration file. A static
// import of a .d.ts-less bridge module is TS7016 under the repo's strict vue-tsc gate — the same
// reason task 37's collaborationCoordinator.test.ts and task 38's fanout.test.ts use the require
// boundary. The contracts below are therefore declared here, in the test, and the require boundary
// is the only untyped edge. shared/runtime/collaboration.js, identity.js and harnessContract.js DO
// ship sibling declaration files and are imported statically, so their contracts are checked by
// vue-tsc itself.
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { COLLABORATION_BUDGETS, CollaborationError } from '../../shared/runtime/collaboration.js';
import type { CollaborationBudgets } from '../../shared/runtime/collaboration.js';
import {
  encodeSessionKey,
  parseEnvironmentId,
  parseHarnessInstanceId,
} from '../../shared/runtime/identity.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import { HARNESS_KINDS } from '../../shared/runtime/harnessContract.js';

/* ------------------------------------------------------------------ contracts */

type ToolInjectionMode = 'native-mcp' | 'ui-only';
type DelegationRole = 'lead' | 'worker';
type DelegationTaskState = 'delegated' | 'succeeded' | 'failed' | 'cancelled' | 'timeout' | 'ambiguous';
type ChildFailurePolicy = 'cascade' | 'independent';
type ToolName = 'delegate' | 'status' | 'message' | 'evidence' | 'control';

interface ToolInjectionSupported {
  readonly state: 'supported';
}
interface ToolInjectionUnsupported {
  readonly state: 'unsupported';
  readonly code: 'unsupported';
  readonly reason: string;
}
type ToolInjectionDeclaration = ToolInjectionSupported | ToolInjectionUnsupported;

interface CapabilityView {
  readonly harnessKind: string;
  readonly mode: ToolInjectionMode;
  readonly injectable: boolean;
  readonly limitation: string | null;
}
interface ScopedToolView {
  readonly toolId: string;
  readonly harnessKind: string;
  readonly name: string;
  readonly scope: Readonly<{ teamId: string; participantId: string }>;
  readonly revoked: boolean;
  readonly createdAt: number;
}
interface ToolScope {
  readonly teamId: string;
  readonly participantId: string;
}
interface ToolCapabilitiesModule {
  readonly TOOL_INJECTION_MODES: readonly ToolInjectionMode[];
  detectToolInjection(input: {
    readonly harnessKind: string;
    readonly toolInjection?: ToolInjectionDeclaration | null;
  }): CapabilityView;
  createToolCapabilityRegistry(): ToolCapabilityRegistry;
}
interface ToolCapabilityRegistry {
  register(input: {
    readonly harnessKind: string;
    readonly toolInjection?: ToolInjectionDeclaration | null;
  }): CapabilityView;
  has(harnessKind: string): boolean;
  capability(harnessKind: string): CapabilityView;
  capabilities(): readonly CapabilityView[];
  registerScopedTool(input: {
    readonly harnessKind: string;
    readonly name: string;
    readonly scope: ToolScope;
    readonly at?: number;
  }): ScopedToolView;
  revokeScopedTool(toolId: string): ScopedToolView;
  scopedTools(input?: { readonly harnessKind?: string }): readonly ScopedToolView[];
  state(): Readonly<{ registered: number; active: number; revoked: number; closed: boolean }>;
  close(): void;
}

interface MailboxLimits {
  readonly maxMessages: number;
  readonly maxMessageChars: number;
  readonly maxParticipantChars: number;
}
interface MessageView {
  readonly messageId: string;
  readonly teamId: string;
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly parentMessageId: string | null;
  readonly at: number;
}
interface MailboxTeamView {
  readonly teamId: string;
  readonly participantCount: number;
  readonly messageCount: number;
  readonly createdAt: number;
}
interface MailboxSnapshotTeam {
  readonly teamId: string;
  readonly createdAt: number;
  readonly participants: readonly string[];
  readonly messages: readonly MessageView[];
}
interface MailboxSnapshot {
  readonly version: 1;
  readonly teams: readonly MailboxSnapshotTeam[];
}
interface MailboxState {
  readonly teams: number;
  readonly participants: number;
  readonly messages: number;
  readonly posted: number;
  readonly closed: boolean;
}
interface MailboxModule {
  readonly MAILBOX_LIMITS: MailboxLimits;
  createMailbox(): Mailbox;
}
interface Mailbox {
  openTeam(input: { readonly teamId: string; readonly at?: number }): MailboxTeamView;
  team(teamId: string): MailboxTeamView;
  teams(): readonly MailboxTeamView[];
  addParticipant(input: {
    readonly teamId: string;
    readonly participantId: string;
    readonly at?: number;
  }): Readonly<{ teamId: string; participantId: string }>;
  post(input: {
    readonly teamId: string;
    readonly from: string;
    readonly to: string;
    readonly text: string;
    readonly parentMessageId?: string | null;
    readonly at?: number;
  }): MessageView;
  messages(input: { readonly teamId: string; readonly participantId: string }): readonly MessageView[];
  depth(teamId: string): number;
  snapshot(): MailboxSnapshot;
  rehydrate(snapshot: MailboxSnapshot): Readonly<{ teams: number; participants: number; messages: number }>;
  state(): MailboxState;
  close(): void;
}

interface CriterionInput {
  readonly id: string;
  readonly text: string;
  readonly required?: boolean;
}
interface CriterionView {
  readonly id: string;
  readonly text: string;
  readonly required: boolean;
}
interface DeliverableInput {
  readonly deliverableId: string;
  readonly artifactHash: string;
  readonly bytes: number;
  readonly paths: readonly string[];
}
interface DeliverableView {
  readonly deliverableId: string;
  readonly artifactHash: string;
  readonly bytes: number;
  readonly paths: readonly string[];
}
interface TaskResolution {
  readonly code: string;
  readonly field: string;
}
interface TaskEndedBy {
  readonly taskId: string;
  readonly action: string;
  readonly at: number;
}
interface TaskView {
  readonly taskId: string;
  readonly teamId: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly criteria: readonly CriterionView[];
  readonly depth: number;
  readonly state: DelegationTaskState;
  readonly delegatedTo: string;
  readonly delegatedBy: string;
  readonly workerHarnessKind: string;
  readonly leadHarnessKind: string;
  readonly prompt: string;
  readonly timeoutMs: number | null;
  readonly deadlineAt: number | null;
  readonly childFailure: ChildFailurePolicy;
  readonly children: readonly string[];
  readonly evidence: readonly DeliverableView[];
  readonly resolution: TaskResolution | null;
  readonly endedBy: TaskEndedBy | null;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly endedAt: number | null;
}
interface MemberView {
  readonly memberId: string;
  readonly teamId: string;
  readonly participantId: string;
  readonly role: DelegationRole;
  readonly harnessKind: string;
  readonly session: SessionRef;
  readonly sessionKey: string;
  readonly joinedAt: number;
}
interface TeamView {
  readonly teamId: string;
  readonly name: string;
  readonly memberCount: number;
  readonly taskCount: number;
  readonly mailboxDepth: number;
  readonly createdAt: number;
}
interface BudgetsUsed {
  readonly concurrency: number;
  readonly sessionMutations: number;
  readonly depth: number;
  readonly children: number;
  readonly mailbox: number;
}
interface BudgetsView {
  readonly limits: CollaborationBudgets;
  readonly used: BudgetsUsed;
}
interface StatusView {
  readonly role: DelegationRole;
  readonly teamId: string;
  readonly participantId: string;
  readonly taskId: string | null;
  readonly tasks: readonly TaskView[];
  readonly mailboxDepth: number;
  readonly budgets: BudgetsView;
}
interface ControlView {
  readonly action: 'cancel' | 'timeout';
  readonly taskId: string;
  readonly transitioned: readonly string[];
  readonly skipped: readonly string[];
  readonly count: number;
}
interface SweepView {
  readonly timedOut: readonly string[];
  readonly count: number;
}
interface ReconcileView {
  readonly retained: readonly { readonly taskId: string; readonly state: DelegationTaskState }[];
  readonly dispatched: readonly string[];
}
interface EvidenceReadView {
  readonly taskId: string;
  readonly evidence: readonly DeliverableView[];
}
interface DelegationState {
  readonly teams: number;
  readonly members: number;
  readonly tasks: number;
  readonly inFlight: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly timeouts: number;
  readonly ambiguous: number;
  readonly reconciles: number;
  readonly closed: boolean;
}
interface DelegationDeliverInput {
  readonly taskId: string;
  readonly teamId: string;
  readonly participantId: string;
  readonly harnessKind: string;
  readonly session: SessionRef;
  readonly prompt: string;
}
interface DelegateInput {
  readonly title: string;
  readonly criteria: readonly CriterionInput[];
  readonly workerParticipantId: string;
  readonly prompt?: string;
  readonly timeoutMs?: number;
  readonly childFailure?: ChildFailurePolicy;
  readonly parentTaskId?: string | null;
  readonly at?: number;
}
interface SubmitEvidenceInput {
  readonly taskId: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly evidence: readonly DeliverableInput[];
  readonly reason?: string;
  readonly at?: number;
}
interface MessageInput {
  readonly to: string;
  readonly text: string;
  readonly parentMessageId?: string | null;
  readonly at?: number;
}
interface ControlInput {
  readonly taskId: string;
  readonly action: 'cancel' | 'timeout';
  readonly reason?: string;
  readonly at?: number;
}
interface ResolvedScope {
  readonly role: DelegationRole;
  readonly teamId: string;
  readonly participantId: string;
  readonly memberId: string;
}
interface LeadScope {
  delegate(input: DelegateInput): Promise<TaskView>;
  readEvidence(input: { readonly taskId: string }): EvidenceReadView;
  control(input: ControlInput): ControlView;
  status(input: { readonly taskId?: string }): StatusView;
  message(input: MessageInput): MessageView;
}
interface WorkerScope {
  submitEvidence(input: SubmitEvidenceInput): TaskView;
  status(input: { readonly taskId?: string }): StatusView;
  message(input: MessageInput): MessageView;
}
interface DelegationServiceModule {
  readonly DELEGATION_ROLES: readonly DelegationRole[];
  createDelegationService(input?: {
    readonly deliver?: (input: DelegationDeliverInput) => Promise<{ readonly ackId?: string } | undefined>;
    readonly mailbox?: Mailbox;
  }): DelegationService;
}
interface DelegationService {
  createTeam(input: { readonly name?: string; readonly teamId?: string; readonly at?: number }): TeamView;
  team(teamId: string): TeamView;
  teams(): readonly TeamView[];
  addMember(input: {
    readonly teamId: string;
    readonly participantId: string;
    readonly role: DelegationRole;
    readonly harnessKind: string;
    readonly session: SessionRef;
    readonly at?: number;
  }): Readonly<{ member: MemberView; scope: LeadScope | WorkerScope }>;
  member(memberId: string): MemberView;
  members(teamId: string): readonly MemberView[];
  delegate(scope: LeadScope, input: DelegateInput): Promise<TaskView>;
  task(taskId: string): TaskView;
  tasks(teamId: string): readonly TaskView[];
  submitEvidence(scope: WorkerScope, input: SubmitEvidenceInput): TaskView;
  readEvidence(scope: LeadScope, input: { readonly taskId: string }): EvidenceReadView;
  status(scope: LeadScope | WorkerScope, input: { readonly taskId?: string }): StatusView;
  message(scope: LeadScope | WorkerScope, input: MessageInput): MessageView;
  control(scope: LeadScope, input: ControlInput): ControlView;
  sweep(input: { readonly at?: number }): SweepView;
  reconcile(input: { readonly at?: number }): ReconcileView;
  resolveScope(scope: unknown): ResolvedScope;
  budgets(): BudgetsView;
  state(): DelegationState;
  close(): void;
}

interface ToolDescriptor {
  readonly name: ToolName;
  readonly roles: readonly DelegationRole[];
}
interface AttachmentView {
  readonly participantId: string;
  readonly harnessKind: string;
  readonly mode: ToolInjectionMode;
  readonly injectable: boolean;
  readonly limitation: string | null;
  readonly tools: readonly { readonly name: ToolName; readonly toolId: string }[];
}
interface AvailabilityTool {
  readonly name: ToolName;
  readonly nativeCallable: boolean;
  readonly uiDispatchable: boolean;
  readonly roles: readonly DelegationRole[];
}
interface AvailabilityView {
  readonly participantId: string;
  readonly harnessKind: string;
  readonly mode: ToolInjectionMode;
  readonly limitation: string | null;
  readonly tools: readonly AvailabilityTool[];
}
interface ToolServerModule {
  readonly TEAM_TOOLS: readonly ToolDescriptor[];
  createToolServer(input: {
    readonly delegation: DelegationService;
    readonly capabilities?: ToolCapabilityRegistry;
  }): ToolServer;
}
interface ToolServer {
  tools(): readonly ToolDescriptor[];
  registerDriver(input: {
    readonly harnessKind: string;
    readonly toolInjection?: ToolInjectionDeclaration | null;
  }): CapabilityView;
  attach(input: { readonly scope: LeadScope | WorkerScope }): AttachmentView;
  detach(input: { readonly scope: LeadScope | WorkerScope }): Readonly<{ participantId: string; revoked: readonly ToolName[] }>;
  availability(input: { readonly scope: LeadScope | WorkerScope }): AvailabilityView;
  call(input: {
    readonly scope: LeadScope | WorkerScope;
    readonly tool: ToolName;
    readonly params: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
  callFromUi(input: {
    readonly scope: LeadScope | WorkerScope;
    readonly tool: ToolName;
    readonly params: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
  state(): Readonly<{ tools: number; nativeCalls: number; uiCalls: number; refused: number; attached: number; closed: boolean }>;
  close(): void;
}

interface Rejection {
  readonly code: string | null;
  readonly field: string | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
}

/* ------------------------------------------------------------------ fixtures */

const require_ = createRequire(import.meta.url);

let capabilitiesModule: ToolCapabilitiesModule;
let mailboxModule: MailboxModule;
let delegationModule: DelegationServiceModule;
let toolServerModule: ToolServerModule;
let sharedContractModule: { readonly COLLABORATION_BUDGETS: CollaborationBudgets };

beforeAll(() => {
  // If any module is missing (the TDD RED state) this throws and every test in the file is
  // reported failed, which is exactly the RED we capture before implementing.
  capabilitiesModule = require_('../../bridge/runtime/collaboration/toolCapabilities.js') as ToolCapabilitiesModule;
  mailboxModule = require_('../../bridge/runtime/collaboration/mailbox.js') as MailboxModule;
  delegationModule = require_('../../bridge/runtime/collaboration/delegationService.js') as DelegationServiceModule;
  toolServerModule = require_('../../bridge/runtime/collaboration/toolServer.js') as ToolServerModule;
  // The shared contract through the SAME require boundary as the bridge modules, so the frozen
  // budgets object can be compared by IDENTITY: the static import above runs through Vite's
  // module graph and is therefore a different realm's instance of the same file.
  sharedContractModule = require_('../../shared/runtime/collaboration.js') as { readonly COLLABORATION_BUDGETS: CollaborationBudgets };
});

const ENV = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const ENV2 = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const HARNESS_OPENCODE = parseHarnessInstanceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const HARNESS_ACP = parseHarnessInstanceId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const HARNESS_CODEX = parseHarnessInstanceId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const HARNESS_KIMI = parseHarnessInstanceId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
const HARNESS_DSH = parseHarnessInstanceId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

const SESSION_OPENCODE: SessionRef = { environmentId: ENV, harnessInstanceId: HARNESS_OPENCODE, nativeSessionId: 'native:opencode-1' };
const SESSION_ACP: SessionRef = { environmentId: ENV, harnessInstanceId: HARNESS_ACP, nativeSessionId: 'native:acp-1' };
const SESSION_CODEX: SessionRef = { environmentId: ENV, harnessInstanceId: HARNESS_CODEX, nativeSessionId: 'native:codex-1' };
const SESSION_KIMI: SessionRef = { environmentId: ENV, harnessInstanceId: HARNESS_KIMI, nativeSessionId: 'native:kimi-1' };
const SESSION_DSH: SessionRef = { environmentId: ENV, harnessInstanceId: HARNESS_DSH, nativeSessionId: 'native:dsh-1' };
const SESSION_OTHER_ENV: SessionRef = { environmentId: ENV2, harnessInstanceId: HARNESS_ACP, nativeSessionId: 'native:acp-other-env' };

const LEAD = '15151515-1515-4515-8515-151515151511';
const W_ACP = '15151515-1515-4515-8515-151515151512';
const W_CODEX = '15151515-1515-4515-8515-151515151513';
const W_KIMI = '15151515-1515-4515-8515-151515151514';
const W_DSH = '15151515-1515-4515-8515-151515151515';
const STRANGER = '15151515-1515-4515-8515-1515151515f0';
const UNKNOWN_PARTICIPANT = '15151515-1515-4515-8515-1515151515ff';

const T0 = 1700000000000;
const CRITERION: CriterionInput = { id: 'c1', text: 'evidence attached and readable' };
const EVIDENCE: DeliverableInput = {
  deliverableId: 'evidence-bridge-review',
  artifactHash: 'f'.repeat(64),
  bytes: 4096,
  paths: ['bridge/runtime/collaboration/delegationService.js', 'app/runtime/delegation.test.ts'],
};
const UI_LIMITATION = 'acp agents do not accept dynamic tool injection';

interface WorkerSeed {
  readonly participantId: string;
  readonly harnessKind: string;
  readonly session: SessionRef;
  readonly scope: WorkerScope;
}
interface TeamSeed {
  readonly team: TeamView;
  readonly lead: { readonly member: MemberView; readonly scope: LeadScope };
  readonly workers: readonly WorkerSeed[];
}

function makeService(deliver?: (input: DelegationDeliverInput) => Promise<{ readonly ackId?: string } | undefined>, mailbox?: Mailbox): DelegationService {
  return deliver === undefined && mailbox === undefined
    ? delegationModule.createDelegationService()
    : delegationModule.createDelegationService({ deliver, mailbox });
}

function makeServer(delegation: DelegationService, capabilities?: ToolCapabilityRegistry): ToolServer {
  return capabilities === undefined
    ? toolServerModule.createToolServer({ delegation })
    : toolServerModule.createToolServer({ delegation, capabilities });
}

function seedTeam(service: DelegationService, workerKinds: readonly string[] = ['acp']): TeamSeed {
  const team = service.createTeam({ name: 'delivery team', at: T0 });
  const leadJoin = service.addMember({
    teamId: team.teamId,
    participantId: LEAD,
    role: 'lead',
    harnessKind: 'opencode',
    session: SESSION_OPENCODE,
    at: T0,
  });
  const byKind: Record<string, { participantId: string; session: SessionRef }> = {
    acp: { participantId: W_ACP, session: SESSION_ACP },
    codex: { participantId: W_CODEX, session: SESSION_CODEX },
    'kimi-web': { participantId: W_KIMI, session: SESSION_KIMI },
    dsh: { participantId: W_DSH, session: SESSION_DSH },
  };
  const workers = workerKinds.map((kind) => {
    const seed = byKind[kind];
    if (seed === undefined) throw new Error(`no fixture worker for harness ${kind}`);
    const join = service.addMember({
      teamId: team.teamId,
      participantId: seed.participantId,
      role: 'worker',
      harnessKind: kind,
      session: seed.session,
      at: T0,
    });
    return { participantId: seed.participantId, harnessKind: kind, session: seed.session, scope: join.scope as WorkerScope };
  });
  return { team, lead: { member: leadJoin.member, scope: leadJoin.scope as LeadScope }, workers };
}

function typedRejection(error: unknown): Rejection {
  const typed = error as { code?: unknown; field?: unknown; detail?: unknown };
  const detail = typed.detail;
  return {
    code: typeof typed.code === 'string' ? typed.code : null,
    field: typeof typed.field === 'string' ? typed.field : null,
    detail: detail !== null && typeof detail === 'object' && !Array.isArray(detail)
      ? (detail as Readonly<Record<string, unknown>>)
      : null,
  };
}

function rejectionOf(run: () => unknown): Rejection {
  try {
    run();
    return { code: null, field: null, detail: null };
  } catch (error) {
    return typedRejection(error);
  }
}

async function rejectionOfAsync(run: () => Promise<unknown>): Promise<Rejection> {
  try {
    await run();
    return { code: null, field: null, detail: null };
  } catch (error) {
    return typedRejection(error);
  }
}

const ackAll: (input: DelegationDeliverInput) => Promise<{ readonly ackId: string }> =
  async (input) => ({ ackId: `ack-${input.taskId}` });

/* ------------------------------------------------------------------ the frozen contract */

describe('delegation contract', () => {
  it('freezes the five shared budgets by identity, not by a second copy', () => {
    const service = makeService();
    const budgets = service.budgets();
    // The child/depth/mailbox limits this service enforces are task 37's frozen object itself:
    // identity, not a re-declared literal.
    expect(budgets.limits).toBe(sharedContractModule.COLLABORATION_BUDGETS);
    expect(budgets.limits).toEqual(COLLABORATION_BUDGETS);
    expect(COLLABORATION_BUDGETS).toEqual({
      maxConcurrency: 4,
      maxSessionMutations: 1,
      maxDepth: 4,
      maxChildren: 32,
      maxMailbox: 1000,
    });
    expect(Object.isFrozen(COLLABORATION_BUDGETS)).toBe(true);
    // The mailbox's own frozen limits row carries the shared count by the same identity.
    expect(mailboxModule.MAILBOX_LIMITS.maxMessages).toBe(sharedContractModule.COLLABORATION_BUDGETS.maxMailbox);
    expect(delegationModule.DELEGATION_ROLES).toEqual(['lead', 'worker']);
    expect(Object.isFrozen(delegationModule.DELEGATION_ROLES)).toBe(true);
    service.close();
  });

  it('freezes the five standard tools and their role table', () => {
    expect(toolServerModule.TEAM_TOOLS.map((tool) => tool.name)).toEqual([
      'delegate', 'status', 'message', 'evidence', 'control',
    ]);
    expect(Object.isFrozen(toolServerModule.TEAM_TOOLS)).toBe(true);
    for (const tool of toolServerModule.TEAM_TOOLS) {
      expect(Object.isFrozen(tool)).toBe(true);
      expect(Object.isFrozen(tool.roles)).toBe(true);
    }
    const byName = new Map(toolServerModule.TEAM_TOOLS.map((tool) => [tool.name, tool.roles]));
    expect(byName.get('delegate')).toEqual(['lead']);
    expect(byName.get('control')).toEqual(['lead']);
    expect(byName.get('status')).toEqual(['lead', 'worker']);
    expect(byName.get('message')).toEqual(['lead', 'worker']);
    expect(byName.get('evidence')).toEqual(['lead', 'worker']);
    expect(capabilitiesModule.TOOL_INJECTION_MODES).toEqual(['native-mcp', 'ui-only']);
    expect(Object.isFrozen(capabilitiesModule.TOOL_INJECTION_MODES)).toBe(true);
  });

  it('validates the harness kind against the shared table, never by assumption', () => {
    const view = capabilitiesModule.detectToolInjection({
      harnessKind: 'kimi-web',
      toolInjection: { state: 'supported' },
    });
    expect(view.harnessKind).toBe('kimi-web');
    expect(HARNESS_KINDS).toEqual(['opencode', 'codex', 'acp', 'kimi-web', 'dsh']);
    const rejection = rejectionOf(() => capabilitiesModule.detectToolInjection({
      harnessKind: 'not-a-harness',
      toolInjection: { state: 'supported' },
    }));
    expect(rejection.code).toBe('invalid_request');
    expect(rejection.field).toBe('tool_capability_kind');
  });

  it('returns frozen read models for every observable state', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp', 'codex']);
    const task = await seed.lead.scope.delegate({
      title: 'review the bridge runtime',
      criteria: [CRITERION],
      workerParticipantId: seed.workers[0].participantId,
      at: T0,
    });
    const team = service.team(seed.team.teamId);
    const member = service.member(seed.lead.member.memberId);
    const status = seed.lead.scope.status({});
    const budgets = service.budgets();
    for (const view of [task, team, member, status, budgets, budgets.used, service.state()]) {
      expect(Object.isFrozen(view)).toBe(true);
    }
    expect(Object.isFrozen(seed.lead.scope)).toBe(true);
    expect(Object.isFrozen(seed.workers[0].scope)).toBe(true);
    expect(Object.isFrozen(task.criteria)).toBe(true);
    expect(Object.isFrozen(task.criteria[0])).toBe(true);
    service.close();
  });

  it('gives every rejection an explicit code and field, never a bare throw', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const task = await seed.lead.scope.delegate({
      title: 'review the bridge runtime',
      criteria: [CRITERION],
      workerParticipantId: seed.workers[0].participantId,
      at: T0,
    });
    // The first report succeeds; the battery below is the duplicate, which must refuse.
    seed.workers[0].scope.submitEvidence({ taskId: task.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 1 });
    const runs: ReadonlyArray<() => unknown> = [
      () => service.createTeam({ name: 'duplicate', teamId: seed.team.teamId, at: T0 }),
      () => service.addMember({ teamId: seed.team.teamId, participantId: LEAD, role: 'worker', harnessKind: 'acp', session: SESSION_ACP, at: T0 }),
      () => service.team('not-a-team'),
      () => service.task('not-a-task'),
      () => service.member('not-a-member'),
      () => seed.lead.scope.readEvidence({ taskId: 'not-a-task' }),
      () => seed.lead.scope.control({ taskId: task.taskId, action: 'pause' as unknown as 'cancel' }),
      () => seed.lead.scope.message({ to: STRANGER, text: 'hello', at: T0 }),
      () => seed.workers[0].scope.submitEvidence({ taskId: task.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 2 }),
    ];
    for (const run of runs) {
      const rejection = rejectionOf(run);
      expect(rejection.code).not.toBeNull();
      expect(rejection.field).not.toBeNull();
    }
    service.close();
  });
});

/* ------------------------------------------------------------------ AC1: cross-harness delegation */

describe('lead delegates across harnesses and reads the evidence', () => {
  it('lead delegates to a worker of a different harness and reads its evidence', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const task = await seed.lead.scope.delegate({
      title: 'review the bridge runtime',
      criteria: [CRITERION],
      workerParticipantId: seed.workers[0].participantId,
      at: T0,
    });
    expect(task.state).toBe('delegated');
    expect(task.workerHarnessKind).toBe('acp');
    expect(task.leadHarnessKind).toBe('opencode');
    expect(task.workerHarnessKind).not.toBe(task.leadHarnessKind);
    expect(task.delegatedTo).toBe(W_ACP);
    expect(task.delegatedBy).toBe(LEAD);
    expect(task.depth).toBe(1);
    expect(task.parentId).toBeNull();
    expect(task.criteria).toEqual([{ id: 'c1', text: 'evidence attached and readable', required: true }]);
    expect(task.childFailure).toBe('independent');

    const done = await seed.workers[0].scope.submitEvidence({
      taskId: task.taskId,
      outcome: 'succeeded',
      evidence: [EVIDENCE],
      at: T0 + 10,
    });
    expect(done.state).toBe('succeeded');
    expect(done.evidence).toEqual([EVIDENCE]);
    expect(done.endedAt).toBe(T0 + 10);

    const read = seed.lead.scope.readEvidence({ taskId: task.taskId });
    expect(read.taskId).toBe(task.taskId);
    expect(read.evidence).toHaveLength(1);
    expect(read.evidence[0]).toEqual(EVIDENCE);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.evidence[0])).toBe(true);
    expect(Object.isFrozen(read.evidence[0].paths)).toBe(true);
    service.close();
  });

  it('delivers the prompt to the worker native session with the task context', async () => {
    const delivered: DelegationDeliverInput[] = [];
    const service = makeService(async (input) => {
      delivered.push(input);
      return { ackId: `ack-${input.taskId}` };
    });
    const seed = seedTeam(service, ['kimi-web']);
    const task = await seed.lead.scope.delegate({
      title: 'audit the kimi transport',
      criteria: [CRITERION],
      workerParticipantId: seed.workers[0].participantId,
      prompt: 'audit the kimi transport and report',
      at: T0,
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual({
      taskId: task.taskId,
      teamId: seed.team.teamId,
      participantId: W_KIMI,
      harnessKind: 'kimi-web',
      session: SESSION_KIMI,
      prompt: 'audit the kimi transport and report',
    });
    expect(delivered[0].session.environmentId).toBe(ENV);
    service.close();
  });

  it('members exchange messages with parent causality through the mailbox', async () => {
    const mailbox = mailboxModule.createMailbox();
    const service = makeService(ackAll, mailbox);
    const seed = seedTeam(service, ['dsh']);
    const task = await seed.lead.scope.delegate({
      title: 'inspect the dsh adapter',
      criteria: [CRITERION],
      workerParticipantId: seed.workers[0].participantId,
      at: T0,
    });
    // The delegation notice is the first mailbox message, addressed to the worker.
    const workerInbox = mailbox.messages({ teamId: seed.team.teamId, participantId: W_DSH });
    expect(workerInbox).toHaveLength(1);
    const notice = workerInbox[0] as MessageView;
    expect(notice.from).toBe(LEAD);
    expect(notice.to).toBe(W_DSH);
    expect(notice.text).toContain(task.taskId);
    expect(notice.parentMessageId).toBeNull();

    const reply = seed.workers[0].scope.message({ to: LEAD, text: 'on it', parentMessageId: notice.messageId, at: T0 + 5 });
    expect(reply.parentMessageId).toBe(notice.messageId);
    expect(reply.from).toBe(W_DSH);
    expect(reply.to).toBe(LEAD);

    const leadInbox = mailbox.messages({ teamId: seed.team.teamId, participantId: LEAD });
    expect(leadInbox.map((entry) => entry.messageId)).toEqual([notice.messageId, reply.messageId]);
    service.close();
    mailbox.close();
  });
});

/* ------------------------------------------------------------------ AC2: no role exceeds its scope */

describe('no role exceeds its scope', () => {
  it('each role scope type cannot reach the other role operations', () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const leadKeys = Object.keys(seed.lead.scope).sort();
    const workerKeys = Object.keys(seed.workers[0].scope).sort();
    expect(leadKeys).toEqual(['control', 'delegate', 'message', 'readEvidence', 'status']);
    expect(workerKeys).toEqual(['message', 'status', 'submitEvidence']);
    // The exclusive operations are unreachable BY TYPE: the worker scope object has no member
    // that reaches them, and the lead scope has no member that submits a worker's evidence.
    expect(workerKeys).not.toContain('delegate');
    expect(workerKeys).not.toContain('control');
    expect(workerKeys).not.toContain('readEvidence');
    expect(leadKeys).not.toContain('submitEvidence');
    expect(Object.isFrozen(seed.lead.scope)).toBe(true);
    expect(Object.isFrozen(seed.workers[0].scope)).toBe(true);
    service.close();
  });

  it('a forged scope object is refused by the tool server', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const server = makeServer(service);
    const forged = Object.freeze({ role: 'lead', teamId: seed.team.teamId, participantId: LEAD });
    const rejection = await rejectionOfAsync(() => server.call({ scope: forged as unknown as LeadScope, tool: 'status', params: {} }));
    expect(rejection.code).toBe('invalid_request');
    expect(rejection.field).toBe('delegation_scope');
    const uiRejection = await rejectionOfAsync(() => server.callFromUi({ scope: forged as unknown as LeadScope, tool: 'status', params: {} }));
    expect(uiRejection.code).toBe('invalid_request');
    expect(uiRejection.field).toBe('delegation_scope');
    service.close();
    server.close();
  });

  it('a worker cannot delegate or control through the tool server', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const server = makeServer(service);
    const worker = seed.workers[0].scope;
    const delegateRejection = await rejectionOfAsync(() => server.call({
      scope: worker,
      tool: 'delegate',
      params: { title: 'escape', criteria: [CRITERION], workerParticipantId: W_ACP },
    }));
    expect(delegateRejection.code).toBe('unauthorized');
    expect(delegateRejection.field).toBe('tool_scope');
    expect(delegateRejection.detail).toEqual({ tool: 'delegate', role: 'worker' });
    const controlRejection = await rejectionOfAsync(() => server.call({
      scope: worker,
      tool: 'control',
      params: { taskId: 'anything', action: 'cancel' },
    }));
    expect(controlRejection.code).toBe('unauthorized');
    expect(controlRejection.field).toBe('tool_scope');
    expect(controlRejection.detail).toEqual({ tool: 'control', role: 'worker' });
    expect(service.state().tasks).toBe(0);
    service.close();
    server.close();
  });

  it('a worker evidence call submits and never reads another workers evidence', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp', 'codex']);
    const server = makeServer(service);
    server.registerDriver({ harnessKind: 'acp', toolInjection: { state: 'supported' } });
    server.attach({ scope: seed.workers[0].scope });
    const own = await seed.lead.scope.delegate({
      title: 'own task', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    const foreign = await seed.lead.scope.delegate({
      title: 'foreign task', criteria: [CRITERION], workerParticipantId: W_CODEX, at: T0 + 1,
    });
    // The worker evidence route submits for its OWN task...
    const submitted = await server.call({
      scope: seed.workers[0].scope,
      tool: 'evidence',
      params: { taskId: own.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 2 },
    }) as TaskView;
    expect(submitted.state).toBe('succeeded');
    // ...and is refused when the task belongs to another worker.
    const rejection = rejectionOf(() => seed.workers[0].scope.submitEvidence({
      taskId: foreign.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 3,
    }));
    expect(rejection.code).toBe('unauthorized');
    expect(rejection.field).toBe('delegation_scope');
    expect(rejection.detail).toEqual({ taskId: foreign.taskId, participantId: W_ACP });
    expect(service.task(foreign.taskId).state).toBe('delegated');
    service.close();
    server.close();
  });

  it('a lead cannot delegate to a worker of another team', async () => {
    const service = makeService(ackAll);
    const a = seedTeam(service, ['acp']);
    const otherLead = '15151515-1515-4515-8515-151515151521';
    const otherWorker = '15151515-1515-4515-8515-151515151522';
    const bTeam = service.createTeam({ name: 'team b', at: T0 });
    const bLeadJoin = service.addMember({ teamId: bTeam.teamId, participantId: otherLead, role: 'lead', harnessKind: 'codex', session: SESSION_CODEX, at: T0 });
    service.addMember({ teamId: bTeam.teamId, participantId: otherWorker, role: 'worker', harnessKind: 'codex', session: SESSION_CODEX, at: T0 });
    const rejection = await rejectionOfAsync(() => a.lead.scope.delegate({
      title: 'cross team work', criteria: [CRITERION], workerParticipantId: otherWorker, at: T0,
    }));
    expect(rejection.code).toBe('unauthorized');
    expect(rejection.field).toBe('delegation_scope');
    expect(service.state().tasks).toBe(0);
    // The team's own lead still works over the same worker record.
    const own = await service.delegate(bLeadJoin.scope as LeadScope, {
      title: 'own work', criteria: [CRITERION], workerParticipantId: otherWorker, at: T0,
    });
    expect(own.teamId).toBe(bTeam.teamId);
    expect(service.state().tasks).toBe(1);
    service.close();
  });

  it('a lead cannot read evidence of another teams task', async () => {
    const service = makeService(ackAll);
    const a = seedTeam(service, ['acp']);
    const otherLead = '15151515-1515-4515-8515-151515151521';
    const otherWorker = '15151515-1515-4515-8515-151515151522';
    const bTeam = service.createTeam({ name: 'team b', at: T0 });
    const bLeadJoin = service.addMember({ teamId: bTeam.teamId, participantId: otherLead, role: 'lead', harnessKind: 'codex', session: SESSION_CODEX, at: T0 });
    service.addMember({ teamId: bTeam.teamId, participantId: otherWorker, role: 'worker', harnessKind: 'codex', session: SESSION_CODEX, at: T0 });
    const foreign = await service.delegate(bLeadJoin.scope as LeadScope, {
      title: 'team b work', criteria: [CRITERION], workerParticipantId: otherWorker, at: T0,
    });
    const rejection = rejectionOf(() => a.lead.scope.readEvidence({ taskId: foreign.taskId }));
    expect(rejection.code).toBe('unauthorized');
    expect(rejection.field).toBe('delegation_scope');
    const controlRejection = rejectionOf(() => a.lead.scope.control({ taskId: foreign.taskId, action: 'cancel', at: T0 + 1 }));
    expect(controlRejection.code).toBe('unauthorized');
    expect(controlRejection.field).toBe('delegation_scope');
    const statusRejection = rejectionOf(() => a.lead.scope.status({ taskId: foreign.taskId }));
    expect(statusRejection.code).toBe('unauthorized');
    expect(statusRejection.field).toBe('delegation_scope');
    expect(service.task(foreign.taskId).state).toBe('delegated');
    service.close();
  });

  it('a member from a different environment is refused with both real ids', () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const rejection = rejectionOf(() => service.addMember({
      teamId: seed.team.teamId,
      participantId: '15151515-1515-4515-8515-151515151531',
      role: 'worker',
      harnessKind: 'acp',
      session: SESSION_OTHER_ENV,
      at: T0,
    }));
    expect(rejection.code).toBe('conflict');
    expect(rejection.field).toBe('delegation_environment');
    expect(rejection.detail).toEqual({ expected: ENV, observed: ENV2 });
    expect(service.members(seed.team.teamId)).toHaveLength(2);
    service.close();
  });

  it('a message to a participant outside the team is refused', () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const rejection = rejectionOf(() => seed.lead.scope.message({ to: STRANGER, text: 'hello', at: T0 }));
    expect(rejection.code).toBe('unauthorized');
    expect(rejection.field).toBe('mailbox_scope');
    expect(rejection.detail).toEqual({ teamId: seed.team.teamId, participantId: STRANGER });
    service.close();
  });
});

/* ------------------------------------------------------------------ AC3: UI-only shows the real limitation */

describe('ui-only shows the real limitation', () => {
  it('a driver without tool-injection capability shows the real ui-only limitation and never pretends to be callable', async () => {
    const mailbox = mailboxModule.createMailbox();
    const service = makeService(ackAll, mailbox);
    const seed = seedTeam(service, ['acp']);
    const server = makeServer(service);
    server.registerDriver({ harnessKind: 'acp', toolInjection: { state: 'unsupported', code: 'unsupported', reason: UI_LIMITATION } });
    server.registerDriver({ harnessKind: 'opencode', toolInjection: { state: 'supported' } });

    const attachment = server.attach({ scope: seed.workers[0].scope });
    expect(attachment.mode).toBe('ui-only');
    expect(attachment.injectable).toBe(false);
    expect(attachment.limitation).toBe(UI_LIMITATION);
    expect(attachment.tools).toEqual([]);

    const availability = server.availability({ scope: seed.workers[0].scope });
    expect(availability.mode).toBe('ui-only');
    expect(availability.limitation).toBe(UI_LIMITATION);
    expect(availability.tools).toHaveLength(5);
    for (const tool of availability.tools) {
      expect(tool.nativeCallable).toBe(false);
      expect(tool.uiDispatchable).toBe(true);
    }
    expect(capabilitiesModule.detectToolInjection({
      harnessKind: 'acp',
      toolInjection: { state: 'unsupported', code: 'unsupported', reason: UI_LIMITATION },
    })).toEqual({ harnessKind: 'acp', mode: 'ui-only', injectable: false, limitation: UI_LIMITATION });

    const rejection = await rejectionOfAsync(() => server.call({
      scope: seed.workers[0].scope,
      tool: 'status',
      params: {},
    }));
    expect(rejection.code).toBe('unsupported');
    expect(rejection.field).toBe('tool_ui_only');
    expect(rejection.detail).toEqual({
      participantId: W_ACP,
      harnessKind: 'acp',
      mode: 'ui-only',
      limitation: UI_LIMITATION,
    });

    const dispatched = await server.callFromUi({
      scope: seed.workers[0].scope,
      tool: 'message',
      params: { to: LEAD, text: 'ui-only worker reporting in', at: T0 },
    }) as MessageView;
    expect(dispatched.from).toBe(W_ACP);
    expect(dispatched.to).toBe(LEAD);
    const state = server.state();
    expect(state.nativeCalls).toBe(0);
    expect(state.uiCalls).toBe(1);
    expect(state.refused).toBe(1);
    service.close();
    server.close();
    mailbox.close();
  });

  it('a driver that declares no tool-injection support at all fails closed to ui-only', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const server = makeServer(service);
    const attachment = server.attach({ scope: seed.workers[0].scope });
    expect(attachment.mode).toBe('ui-only');
    expect(attachment.limitation).toBe('driver declares no tool-injection support');
    const rejection = await rejectionOfAsync(() => server.call({
      scope: seed.workers[0].scope,
      tool: 'status',
      params: {},
    }));
    expect(rejection.code).toBe('unsupported');
    expect(rejection.field).toBe('tool_ui_only');
    expect(rejection.detail).toEqual({
      participantId: W_ACP,
      harnessKind: 'acp',
      mode: 'ui-only',
      limitation: 'driver declares no tool-injection support',
    });
    // The registration path refuses the same way: nothing is injected for a driver that
    // cannot receive an injection.
    const registerRejection = rejectionOf(() => server.registerDriver({ harnessKind: 'acp' }));
    expect(registerRejection.code).toBe('invalid_request');
    expect(registerRejection.field).toBe('tool_injection_declaration');
    service.close();
    server.close();
  });

  it('a native-mcp driver registers temporary scoped tools that are revocable', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const server = makeServer(service);
    server.registerDriver({ harnessKind: 'opencode', toolInjection: { state: 'supported' } });
    const attachment = server.attach({ scope: seed.lead.scope });
    expect(attachment.mode).toBe('native-mcp');
    expect(attachment.injectable).toBe(true);
    expect(attachment.limitation).toBeNull();
    expect(attachment.tools.map((tool) => tool.name)).toEqual(['delegate', 'status', 'message', 'evidence', 'control']);
    expect(new Set(attachment.tools.map((tool) => tool.toolId)).size).toBe(5);

    const status = await server.call({ scope: seed.lead.scope, tool: 'status', params: {} }) as StatusView;
    expect(status.role).toBe('lead');
    expect(server.state().nativeCalls).toBe(1);

    // Attaching again is idempotent: the same five scoped tools, not ten.
    const again = server.attach({ scope: seed.lead.scope });
    expect(again.tools).toHaveLength(5);

    const revoked = server.detach({ scope: seed.lead.scope });
    expect(revoked.participantId).toBe(LEAD);
    expect(revoked.revoked).toEqual(['delegate', 'status', 'message', 'evidence', 'control']);
    const rejection = await rejectionOfAsync(() => server.call({ scope: seed.lead.scope, tool: 'status', params: {} }));
    expect(rejection.code).toBe('unsupported');
    expect(rejection.field).toBe('tool_injection_inactive');
    expect(rejection.detail).toEqual({ participantId: LEAD, harnessKind: 'opencode', name: 'status' });
    service.close();
    server.close();
  });
});

/* ------------------------------------------------------------------ AC4: the shared limits really run */

describe('child, depth, mailbox and concurrency limits really run', () => {
  it('the thirty-third child of one parent is refused with the real counts', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const root = await seed.lead.scope.delegate({
      title: 'root', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    await seed.workers[0].scope.submitEvidence({ taskId: root.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 1 });
    for (let index = 0; index < COLLABORATION_BUDGETS.maxChildren; index += 1) {
      const child = await seed.lead.scope.delegate({
        title: `child ${index}`,
        criteria: [CRITERION],
        workerParticipantId: W_ACP,
        parentTaskId: root.taskId,
        at: T0 + 2 + index,
      });
      expect(child.depth).toBe(2);
      await seed.workers[0].scope.submitEvidence({
        taskId: child.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 2 + index,
      });
    }
    expect(service.task(root.taskId).children).toHaveLength(32);
    const rejection = await rejectionOfAsync(() => seed.lead.scope.delegate({
      title: 'child 32',
      criteria: [CRITERION],
      workerParticipantId: W_ACP,
      parentTaskId: root.taskId,
      at: T0 + 100,
    }));
    expect(rejection.code).toBe('conflict');
    expect(rejection.field).toBe('collaboration_children');
    expect(rejection.detail).toEqual({ parentTaskId: root.taskId, children: 32, limit: 32 });
    expect(service.task(root.taskId).children).toHaveLength(32);
    expect(service.state().tasks).toBe(33);
    service.close();
  });

  it('a delegation chain deeper than depth 4 is refused with the real depth', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    let parent = await seed.lead.scope.delegate({
      title: 'level 1', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    await seed.workers[0].scope.submitEvidence({ taskId: parent.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 1 });
    for (let depth = 2; depth <= COLLABORATION_BUDGETS.maxDepth; depth += 1) {
      const child = await seed.lead.scope.delegate({
        title: `level ${depth}`,
        criteria: [CRITERION],
        workerParticipantId: W_ACP,
        parentTaskId: parent.taskId,
        at: T0 + depth,
      });
      expect(child.depth).toBe(depth);
      await seed.workers[0].scope.submitEvidence({
        taskId: child.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + depth,
      });
      parent = child;
    }
    const rejection = await rejectionOfAsync(() => seed.lead.scope.delegate({
      title: 'level 5',
      criteria: [CRITERION],
      workerParticipantId: W_ACP,
      parentTaskId: parent.taskId,
      at: T0 + 10,
    }));
    expect(rejection.code).toBe('conflict');
    expect(rejection.field).toBe('collaboration_depth');
    expect(rejection.detail).toEqual({ depth: 5, limit: 4 });
    expect(service.state().tasks).toBe(4);
    service.close();
  });

  it('an unbounded delegation chain terminates at the depth limit', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    let parent = await seed.lead.scope.delegate({
      title: 'root', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    await seed.workers[0].scope.submitEvidence({ taskId: parent.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 1 });
    let refused: Rejection | null = null;
    for (let step = 2; step <= 12 && refused === null; step += 1) {
      let created: TaskView;
      try {
        created = await seed.lead.scope.delegate({
          title: `chain ${step}`,
          criteria: [CRITERION],
          workerParticipantId: W_ACP,
          parentTaskId: parent.taskId,
          at: T0 + step,
        });
      } catch (error) {
        refused = typedRejection(error);
        break;
      }
      await seed.workers[0].scope.submitEvidence({
        taskId: created.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + step,
      });
      parent = created;
    }
    expect(refused).not.toBeNull();
    expect(refused?.code).toBe('conflict');
    expect(refused?.field).toBe('collaboration_depth');
    expect(refused?.detail).toEqual({ depth: 5, limit: 4 });
    expect(service.state().tasks).toBe(4);
    service.close();
  });

  it('the one-thousand-and-first mailbox message is refused with the real counts', () => {
    const mailbox = mailboxModule.createMailbox();
    const teamId = '15151515-1515-4515-8515-151515151541';
    mailbox.openTeam({ teamId, at: T0 });
    mailbox.addParticipant({ teamId, participantId: W_ACP, at: T0 });
    mailbox.addParticipant({ teamId, participantId: W_CODEX, at: T0 });
    for (let index = 0; index < COLLABORATION_BUDGETS.maxMailbox; index += 1) {
      const message = mailbox.post({ teamId, from: W_ACP, to: W_CODEX, text: `notice ${index}`, at: T0 + index });
      expect(message.messageId).toBeTypeOf('string');
    }
    expect(mailbox.depth(teamId)).toBe(1000);
    const rejection = rejectionOf(() => mailbox.post({ teamId, from: W_ACP, to: W_CODEX, text: 'one too many', at: T0 + 2000 }));
    expect(rejection.code).toBe('conflict');
    expect(rejection.field).toBe('mailbox_full');
    expect(rejection.detail).toEqual({ teamId, limit: 1000, used: 1000 });
    expect(mailbox.depth(teamId)).toBe(1000);
    expect(mailbox.state().messages).toBe(1000);
    expect(mailbox.state().posted).toBe(1000);
    mailbox.close();
  });

  it('a delegation whose team mailbox is full is refused with the real counts', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    for (let index = 0; index < COLLABORATION_BUDGETS.maxMailbox; index += 1) {
      seed.lead.scope.message({ to: W_ACP, text: `filler ${index}`, at: T0 + index });
    }
    const rejection = await rejectionOfAsync(() => seed.lead.scope.delegate({
      title: 'no room for the notice', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0 + 2000,
    }));
    expect(rejection.code).toBe('conflict');
    expect(rejection.field).toBe('collaboration_mailbox');
    expect(rejection.detail).toEqual({ teamId: seed.team.teamId, limit: 1000, used: 1000 });
    expect(service.state().tasks).toBe(0);
    service.close();
  });

  it('the fifth concurrent delegation is refused with the real counts', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp', 'codex', 'kimi-web', 'dsh']);
    for (let index = 0; index < COLLABORATION_BUDGETS.maxConcurrency; index += 1) {
      const task = await seed.lead.scope.delegate({
        title: `parallel ${index}`,
        criteria: [CRITERION],
        workerParticipantId: seed.workers[index]!.participantId,
        at: T0 + index,
      });
      expect(task.state).toBe('delegated');
    }
    const rejection = await rejectionOfAsync(() => seed.lead.scope.delegate({
      title: 'parallel 4',
      criteria: [CRITERION],
      workerParticipantId: seed.workers[0]!.participantId,
      at: T0 + 10,
    }));
    expect(rejection.code).toBe('conflict');
    expect(rejection.field).toBe('collaboration_concurrency');
    expect(rejection.detail).toEqual({ running: 4, limit: 4 });
    // A finished delegation frees its slot, and the next one is admitted.
    await seed.workers[0]!.scope.submitEvidence({
      taskId: service.tasks(seed.team.teamId)[0]!.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 11,
    });
    const admitted = await seed.lead.scope.delegate({
      title: 'parallel 4', criteria: [CRITERION], workerParticipantId: seed.workers[0]!.participantId, at: T0 + 12,
    });
    expect(admitted.state).toBe('delegated');
    expect(service.state().tasks).toBe(5);
    service.close();
  });

  it('a second concurrent delegation on one native session is refused', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const first = await seed.lead.scope.delegate({
      title: 'first', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    const sessionKey = encodeSessionKey(SESSION_ACP);
    const rejection = await rejectionOfAsync(() => seed.lead.scope.delegate({
      title: 'second', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0 + 1,
    }));
    expect(rejection.code).toBe('conflict');
    expect(rejection.field).toBe('collaboration_session_mutation');
    expect(rejection.detail).toEqual({ sessionKey, limit: 1 });
    await seed.workers[0].scope.submitEvidence({ taskId: first.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 2 });
    const retry = await seed.lead.scope.delegate({
      title: 'second', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0 + 3,
    });
    expect(retry.state).toBe('delegated');
    service.close();
  });

  it('reports the used budgets with real numbers', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp', 'codex']);
    const root = await seed.lead.scope.delegate({
      title: 'root', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    await seed.lead.scope.delegate({
      title: 'child', criteria: [CRITERION], workerParticipantId: W_CODEX, parentTaskId: root.taskId, at: T0 + 1,
    });
    const budgets = service.budgets();
    expect(budgets.limits).toBe(sharedContractModule.COLLABORATION_BUDGETS);
    expect(budgets.used).toEqual({
      concurrency: 2,
      sessionMutations: 2,
      depth: 2,
      children: 1,
      mailbox: 2,
    });
    expect(Object.isFrozen(budgets)).toBe(true);
    expect(Object.isFrozen(budgets.used)).toBe(true);
    service.close();
  });
});

/* ------------------------------------------------------------------ failure classes */

describe('failure classes terminate or reconcile, never hang', () => {
  it('malformed and malicious delegate input is refused before anything is created', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const runs: ReadonlyArray<() => Promise<unknown>> = [
      () => seed.lead.scope.delegate({ title: '', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0 }),
      () => seed.lead.scope.delegate({ title: 'no criteria', criteria: [], workerParticipantId: W_ACP, at: T0 }),
      () => seed.lead.scope.delegate({
        title: 'duplicate criteria',
        criteria: [{ id: 'c1', text: 'a' }, { id: 'c1', text: 'b' }],
        workerParticipantId: W_ACP,
        at: T0,
      }),
      () => seed.lead.scope.delegate({ title: 'bad worker', criteria: [CRITERION], workerParticipantId: 'not-a-uuid', at: T0 }),
      () => seed.lead.scope.delegate({ title: 'unknown worker', criteria: [CRITERION], workerParticipantId: UNKNOWN_PARTICIPANT, at: T0 }),
      () => seed.lead.scope.delegate({ title: 'lead is not a worker', criteria: [CRITERION], workerParticipantId: LEAD, at: T0 }),
      () => seed.lead.scope.delegate({ title: 'x'.repeat(513), criteria: [CRITERION], workerParticipantId: W_ACP, at: T0 }),
      () => seed.lead.scope.delegate({ title: 'huge prompt', criteria: [CRITERION], workerParticipantId: W_ACP, prompt: 'x'.repeat(32769), at: T0 }),
      () => seed.lead.scope.delegate({ title: 'bad parent', criteria: [CRITERION], workerParticipantId: W_ACP, parentTaskId: 'not-a-task', at: T0 }),
      () => seed.lead.scope.delegate({ title: 'unknown parent', criteria: [CRITERION], workerParticipantId: W_ACP, parentTaskId: '15151515-1515-4515-8515-1515151515ee', at: T0 }),
      () => seed.lead.scope.delegate({ title: 'negative timeout', criteria: [CRITERION], workerParticipantId: W_ACP, timeoutMs: -1, at: T0 }),
      () => seed.lead.scope.delegate({ title: 'bad policy', criteria: [CRITERION], workerParticipantId: W_ACP, childFailure: 'nope' as unknown as ChildFailurePolicy, at: T0 }),
    ];
    const fields: string[] = [];
    for (const run of runs) {
      const rejection = await rejectionOfAsync(run);
      expect(rejection.code).not.toBeNull();
      expect(rejection.field).not.toBeNull();
      fields.push(rejection.field as string);
    }
    expect(fields).toEqual([
      'task_title',
      'task_criteria',
      'task_criteria',
      'delegation_participant',
      'delegation_worker_unknown',
      'delegation_role',
      'task_title',
      'delegation_prompt',
      'task_id',
      'delegation_task_unknown',
      'delegation_timeout',
      'delegation_child_failure',
    ]);
    expect(service.state().tasks).toBe(0);
    expect(service.budgets().used.mailbox).toBe(0);
    service.close();
  });

  it('cascade cancel terminates the whole subtree and records the cancelling ancestor', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp', 'codex', 'kimi-web']);
    const root = await seed.lead.scope.delegate({
      title: 'root', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    const child = await seed.lead.scope.delegate({
      title: 'child', criteria: [CRITERION], workerParticipantId: W_CODEX, parentTaskId: root.taskId, at: T0 + 1,
    });
    const grandchild = await seed.lead.scope.delegate({
      title: 'grandchild', criteria: [CRITERION], workerParticipantId: W_KIMI, parentTaskId: child.taskId, at: T0 + 2,
    });
    const result = seed.lead.scope.control({ taskId: root.taskId, action: 'cancel', reason: 'lead cancelled', at: T0 + 100 });
    expect(result.action).toBe('cancel');
    expect(result.count).toBe(3);
    expect(result.transitioned).toEqual([root.taskId, child.taskId, grandchild.taskId]);
    expect(result.skipped).toEqual([]);
    for (const taskId of result.transitioned) {
      const view = service.task(taskId);
      expect(view.state).toBe('cancelled');
      expect(view.endedBy).toEqual({ taskId: root.taskId, action: 'cancel', at: T0 + 100 });
      expect(view.resolution).toEqual({ code: 'cancelled', field: 'delegation_cancel' });
      expect(view.endedAt).toBe(T0 + 100);
    }
    const again = seed.lead.scope.control({ taskId: root.taskId, action: 'cancel', at: T0 + 200 });
    expect(again.count).toBe(0);
    expect(again.transitioned).toEqual([]);
    expect(again.skipped).toEqual([root.taskId, child.taskId, grandchild.taskId]);
    expect(service.state().inFlight).toBe(0);
    service.close();
  });

  it('the timeout sweep terminates a delegation whose worker never reports', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp', 'codex']);
    const task = await seed.lead.scope.delegate({
      title: 'slow work', criteria: [CRITERION], workerParticipantId: W_ACP, timeoutMs: 5000, at: T0,
    });
    expect(task.deadlineAt).toBe(T0 + 5000);
    const before = service.sweep({ at: T0 + 4999 });
    expect(before.count).toBe(0);
    expect(before.timedOut).toEqual([]);
    expect(service.task(task.taskId).state).toBe('delegated');
    const after = service.sweep({ at: T0 + 5000 });
    expect(after.count).toBe(1);
    expect(after.timedOut).toEqual([task.taskId]);
    const timedOut = service.task(task.taskId);
    expect(timedOut.state).toBe('timeout');
    expect(timedOut.endedBy).toEqual({ taskId: task.taskId, action: 'timeout', at: T0 + 5000 });
    expect(timedOut.resolution).toEqual({ code: 'timeout', field: 'delegation_timeout' });
    expect(service.state().inFlight).toBe(0);
    service.close();
  });

  it('a late worker report cannot resurrect a terminal task', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const task = await seed.lead.scope.delegate({
      title: 'cancelled work', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    seed.lead.scope.control({ taskId: task.taskId, action: 'cancel', at: T0 + 1 });
    const rejection = rejectionOf(() => seed.workers[0].scope.submitEvidence({
      taskId: task.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 2,
    }));
    expect(rejection.code).toBe('conflict');
    expect(rejection.field).toBe('delegation_state');
    expect(service.task(task.taskId).state).toBe('cancelled');
    expect(service.task(task.taskId).evidence).toEqual([]);
    service.close();
  });

  it('reconcile after a restart retains every unresolved delegation and dispatches nothing', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp', 'codex']);
    const first = await seed.lead.scope.delegate({
      title: 'first', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    const second = await seed.lead.scope.delegate({
      title: 'second', criteria: [CRITERION], workerParticipantId: W_CODEX, at: T0 + 1,
    });
    await seed.workers[0].scope.submitEvidence({ taskId: first.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 2 });
    const result = service.reconcile({ at: T0 + 9999 });
    expect(result.dispatched).toEqual([]);
    expect(result.retained.map((entry) => entry.taskId)).toEqual([second.taskId]);
    expect(result.retained[0]?.state).toBe('ambiguous');
    const view = service.task(second.taskId);
    expect(view.state).toBe('ambiguous');
    expect(view.resolution).toEqual({ code: 'reconcile_required', field: 'delegation_restart_ambiguous' });
    expect(service.state().reconciles).toBe(1);
    expect(service.state().inFlight).toBe(0);
    // A second reconcile retains nothing new.
    const again = service.reconcile({ at: T0 + 10000 });
    expect(again.retained).toEqual([]);
    expect(again.dispatched).toEqual([]);
    service.close();
  });

  it('a child failure cascades to the parent only when the recorded policy says so', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp', 'codex', 'kimi-web']);
    const cascading = await seed.lead.scope.delegate({
      title: 'cascading parent', criteria: [CRITERION], workerParticipantId: W_ACP, childFailure: 'cascade', at: T0,
    });
    const cascadingChild = await seed.lead.scope.delegate({
      title: 'cascading child', criteria: [CRITERION], workerParticipantId: W_CODEX, parentTaskId: cascading.taskId, at: T0 + 1,
    });
    const failed = await seed.workers[1]!.scope.submitEvidence({
      taskId: cascadingChild.taskId, outcome: 'failed', reason: 'worker could not compile', evidence: [EVIDENCE], at: T0 + 2,
    });
    expect(failed.state).toBe('failed');
    expect(failed.resolution).toEqual({ code: 'delegation_failed', field: 'delegation_outcome' });
    expect(failed.reason).toBe('worker could not compile');
    const parentView = service.task(cascading.taskId);
    expect(parentView.state).toBe('failed');
    expect(parentView.endedBy).toEqual({ taskId: cascadingChild.taskId, action: 'child-failed', at: T0 + 2 });

    const independent = await seed.lead.scope.delegate({
      title: 'independent parent', criteria: [CRITERION], workerParticipantId: W_KIMI, childFailure: 'independent', at: T0 + 3,
    });
    const independentChild = await seed.lead.scope.delegate({
      title: 'independent child', criteria: [CRITERION], workerParticipantId: W_ACP, parentTaskId: independent.taskId, childFailure: 'independent', at: T0 + 4,
    });
    await seed.workers[0]!.scope.submitEvidence({
      taskId: independentChild.taskId, outcome: 'failed', reason: 'worker could not compile', evidence: [EVIDENCE], at: T0 + 5,
    });
    expect(service.task(independentChild.taskId).state).toBe('failed');
    expect(service.task(independent.taskId).state).toBe('delegated');
    expect(service.task(independent.taskId).endedBy).toBeNull();
    service.close();
  });

  it('a deliver failure fails only its own task and leaves the sibling running', async () => {
    let codexFailed = false;
    const deliver = async (input: DelegationDeliverInput): Promise<{ readonly ackId: string }> => {
      if (input.participantId === W_CODEX && !codexFailed) {
        codexFailed = true;
        throw new CollaborationError('source_unavailable', 'delegation_send');
      }
      return { ackId: `ack-${input.taskId}` };
    };
    const service = makeService(deliver);
    const seed = seedTeam(service, ['acp', 'codex']);
    const healthy = await seed.lead.scope.delegate({
      title: 'healthy', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    const failed = await seed.lead.scope.delegate({
      title: 'unreachable', criteria: [CRITERION], workerParticipantId: W_CODEX, at: T0 + 1,
    });
    expect(failed.state).toBe('failed');
    expect(failed.resolution).toEqual({ code: 'source_unavailable', field: 'delegation_send' });
    expect(service.task(healthy.taskId).state).toBe('delegated');
    expect(service.state().inFlight).toBe(1);
    // The failed task released its slot: the same worker can be delegated again.
    const retry = await seed.lead.scope.delegate({
      title: 'retry', criteria: [CRITERION], workerParticipantId: W_CODEX, at: T0 + 2,
    });
    expect(retry.state).toBe('delegated');
    expect(service.state().inFlight).toBe(2);
    service.close();
  });

  it('a deliver result without an ack is retained as ambiguous', async () => {
    const service = makeService(async () => ({}));
    const seed = seedTeam(service, ['acp']);
    const task = await seed.lead.scope.delegate({
      title: 'ambiguous send', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    expect(task.state).toBe('ambiguous');
    expect(task.resolution).toEqual({ code: 'reconcile_required', field: 'delegation_ambiguous' });
    expect(service.state().ambiguous).toBe(1);
    expect(service.state().inFlight).toBe(0);
    service.close();
  });

  it('close refuses every entry point with an explicit code', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp']);
    const task = await seed.lead.scope.delegate({
      title: 'open work', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    });
    service.close();
    const runs: ReadonlyArray<() => unknown> = [
      () => service.createTeam({ name: 'late', at: T0 }),
      () => service.addMember({ teamId: seed.team.teamId, participantId: STRANGER, role: 'worker', harnessKind: 'acp', session: SESSION_ACP, at: T0 }),
      () => service.submitEvidence(seed.workers[0].scope, { taskId: task.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 }),
      () => service.readEvidence(seed.lead.scope, { taskId: task.taskId }),
      () => service.status(seed.lead.scope, {}),
      () => service.message(seed.lead.scope, { to: W_ACP, text: 'late', at: T0 }),
      () => service.control(seed.lead.scope, { taskId: task.taskId, action: 'cancel', at: T0 }),
      () => service.sweep({ at: T0 }),
      () => service.reconcile({ at: T0 }),
      () => service.budgets(),
    ];
    for (const run of runs) {
      const rejection = rejectionOf(run);
      expect(rejection.code).toBe('cancelled');
      expect(rejection.field).toBe('delegation_service_closed');
    }
    // The async delegate rejects with the same typed refusal.
    const asyncRejection = await rejectionOfAsync(() => service.delegate(seed.lead.scope, {
      title: 'late', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0,
    }));
    expect(asyncRejection.code).toBe('cancelled');
    expect(asyncRejection.field).toBe('delegation_service_closed');
    // state() still reports the closed flag rather than throwing.
    expect(service.state().closed).toBe(true);
  });
});

/* ------------------------------------------------------------------ the participant mailbox */

describe('participant mailbox', () => {
  const TEAM = '15151515-1515-4515-8515-151515151541';

  it('persists across a restart with parent causality intact', () => {
    const mailbox = mailboxModule.createMailbox();
    mailbox.openTeam({ teamId: TEAM, at: T0 });
    mailbox.addParticipant({ teamId: TEAM, participantId: W_ACP, at: T0 });
    mailbox.addParticipant({ teamId: TEAM, participantId: W_CODEX, at: T0 });
    const first = mailbox.post({ teamId: TEAM, from: W_ACP, to: W_CODEX, text: 'status?', at: T0 });
    const reply = mailbox.post({ teamId: TEAM, from: W_CODEX, to: W_ACP, text: 'running', parentMessageId: first.messageId, at: T0 + 1 });
    expect(reply.parentMessageId).toBe(first.messageId);

    const restored = mailboxModule.createMailbox();
    const summary = restored.rehydrate(mailbox.snapshot());
    expect(summary).toEqual({ teams: 1, participants: 2, messages: 2 });
    expect(restored.messages({ teamId: TEAM, participantId: W_ACP })).toEqual(mailbox.messages({ teamId: TEAM, participantId: W_ACP }));
    expect(restored.messages({ teamId: TEAM, participantId: W_CODEX })).toEqual(mailbox.messages({ teamId: TEAM, participantId: W_CODEX }));
    expect(restored.state()).toEqual(mailbox.state());
    expect(restored.depth(TEAM)).toBe(2);
    expect(Object.isFrozen(restored.messages({ teamId: TEAM, participantId: W_ACP }))).toBe(true);
    expect(restored.messages({ teamId: TEAM, participantId: W_ACP })[1]?.parentMessageId).toBe(first.messageId);
    mailbox.close();
    restored.close();
  });

  it('rehydrate enforces the participant, count and uniqueness bounds a live post obeys', () => {
    const messageAt = (index: number, from: string, to: string, teamId: string = TEAM): MessageView => ({
      messageId: `15151515-1515-4111-8111-${String(index).padStart(12, '0')}`,
      teamId,
      from,
      to,
      text: `message ${index}`,
      parentMessageId: null,
      at: T0 + index,
    });
    const snapshotWith = (messages: readonly MessageView[]): MailboxSnapshot => ({
      version: 1,
      teams: [{ teamId: TEAM, createdAt: T0, participants: [W_ACP, W_CODEX], messages }],
    });
    const rehydrateInto = (snapshot: MailboxSnapshot) => {
      const restored = mailboxModule.createMailbox();
      const rejection = rejectionOf(() => restored.rehydrate(snapshot));
      return { restored, rejection };
    };

    // An unregistered SENDER is a scope violation, exactly like a live post.
    const forgedSender = rehydrateInto(snapshotWith([messageAt(1, STRANGER, W_ACP)]));
    expect(forgedSender.rejection.code).toBe('unauthorized');
    expect(forgedSender.rejection.field).toBe('mailbox_scope');
    expect(forgedSender.restored.state().teams).toBe(0);
    expect(forgedSender.restored.state().messages).toBe(0);
    forgedSender.restored.close();

    // An unregistered RECIPIENT is refused the same way.
    const forgedRecipient = rehydrateInto(snapshotWith([messageAt(1, W_ACP, STRANGER)]));
    expect(forgedRecipient.rejection.code).toBe('unauthorized');
    expect(forgedRecipient.rejection.field).toBe('mailbox_scope');
    forgedRecipient.restored.close();

    // A duplicate message id inside one team is a conflict, never a silent second copy.
    const duplicate = rehydrateInto(snapshotWith([messageAt(1, W_ACP, W_CODEX), messageAt(2, W_ACP, W_CODEX), messageAt(1, W_ACP, W_CODEX)]));
    expect(duplicate.rejection.code).toBe('conflict');
    expect(duplicate.rejection.field).toBe('mailbox_snapshot');
    duplicate.restored.close();

    // The per-team message count may not exceed the shared budget, however the snapshot reads.
    const overCapacity = rehydrateInto(snapshotWith(
      Array.from({ length: mailboxModule.MAILBOX_LIMITS.maxMessages + 1 }, (_entry, index) => messageAt(index + 1, W_ACP, W_CODEX)),
    ));
    expect(overCapacity.rejection.code).toBe('conflict');
    expect(overCapacity.rejection.field).toBe('mailbox_full');
    expect(overCapacity.restored.state().messages).toBe(0);
    overCapacity.restored.close();

    // A rejected snapshot publishes NOTHING: a later invalid team leaves no earlier team behind.
    const otherTeam = '15151515-1515-4515-8515-151515151542';
    const partial = rehydrateInto({
      version: 1,
      teams: [
        { teamId: TEAM, createdAt: T0, participants: [W_ACP, W_CODEX], messages: [messageAt(1, W_ACP, W_CODEX)] },
        { teamId: otherTeam, createdAt: T0, participants: [W_ACP], messages: [messageAt(2, STRANGER, W_ACP, otherTeam)] },
      ],
    });
    expect(partial.rejection.code).toBe('unauthorized');
    expect(partial.rejection.field).toBe('mailbox_scope');
    expect(partial.restored.state().teams).toBe(0);
    expect(partial.restored.state().messages).toBe(0);
    partial.restored.close();
  });

  it('refuses a reply whose parent is unknown or belongs to another team', () => {
    const mailbox = mailboxModule.createMailbox();
    mailbox.openTeam({ teamId: TEAM, at: T0 });
    mailbox.addParticipant({ teamId: TEAM, participantId: W_ACP, at: T0 });
    mailbox.addParticipant({ teamId: TEAM, participantId: W_CODEX, at: T0 });
    const first = mailbox.post({ teamId: TEAM, from: W_ACP, to: W_CODEX, text: 'status?', at: T0 });
    const otherTeam = '15151515-1515-4515-8515-151515151542';
    mailbox.openTeam({ teamId: otherTeam, at: T0 });
    mailbox.addParticipant({ teamId: otherTeam, participantId: W_KIMI, at: T0 });
    mailbox.addParticipant({ teamId: otherTeam, participantId: W_DSH, at: T0 });
    const foreign = mailbox.post({ teamId: otherTeam, from: W_KIMI, to: W_DSH, text: 'other team', at: T0 });

    const unknownParent = rejectionOf(() => mailbox.post({
      teamId: TEAM, from: W_CODEX, to: W_ACP, text: 'orphan', parentMessageId: '15151515-1515-4515-8515-151515151599', at: T0 + 1,
    }));
    expect(unknownParent.code).toBe('invalid_request');
    expect(unknownParent.field).toBe('mailbox_parent');
    expect(unknownParent.detail).toEqual({ teamId: TEAM, parentMessageId: '15151515-1515-4515-8515-151515151599' });

    const crossTeamParent = rejectionOf(() => mailbox.post({
      teamId: TEAM, from: W_CODEX, to: W_ACP, text: 'cross team reply', parentMessageId: foreign.messageId, at: T0 + 2,
    }));
    expect(crossTeamParent.code).toBe('invalid_request');
    expect(crossTeamParent.field).toBe('mailbox_parent');
    expect(mailbox.depth(TEAM)).toBe(1);
    expect(mailbox.messages({ teamId: TEAM, participantId: W_ACP })[0]?.messageId).toBe(first.messageId);
    mailbox.close();
  });

  it('authorizes reads by team membership and never leaks another conversation', () => {
    const mailbox = mailboxModule.createMailbox();
    mailbox.openTeam({ teamId: TEAM, at: T0 });
    mailbox.addParticipant({ teamId: TEAM, participantId: W_ACP, at: T0 });
    mailbox.addParticipant({ teamId: TEAM, participantId: W_CODEX, at: T0 });
    mailbox.addParticipant({ teamId: TEAM, participantId: W_KIMI, at: T0 });
    mailbox.post({ teamId: TEAM, from: W_ACP, to: W_CODEX, text: 'private', at: T0 });
    const outsider = rejectionOf(() => mailbox.messages({ teamId: TEAM, participantId: STRANGER }));
    expect(outsider.code).toBe('unauthorized');
    expect(outsider.field).toBe('mailbox_scope');
    // A third member sees nothing addressed to or from it.
    expect(mailbox.messages({ teamId: TEAM, participantId: W_KIMI })).toEqual([]);
    const seen = mailbox.messages({ teamId: TEAM, participantId: W_CODEX });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toBe('private');
    mailbox.close();
  });

  it('bounds one message at 32 KiB with the real length', () => {
    const mailbox = mailboxModule.createMailbox();
    expect(mailboxModule.MAILBOX_LIMITS).toEqual({
      maxMessages: COLLABORATION_BUDGETS.maxMailbox,
      maxMessageChars: 32768,
      maxParticipantChars: 128,
    });
    mailbox.openTeam({ teamId: TEAM, at: T0 });
    mailbox.addParticipant({ teamId: TEAM, participantId: W_ACP, at: T0 });
    mailbox.addParticipant({ teamId: TEAM, participantId: W_CODEX, at: T0 });
    const exact = mailbox.post({ teamId: TEAM, from: W_ACP, to: W_CODEX, text: 'x'.repeat(32768), at: T0 });
    expect(exact.text).toHaveLength(32768);
    const rejection = rejectionOf(() => mailbox.post({ teamId: TEAM, from: W_ACP, to: W_CODEX, text: 'x'.repeat(32769), at: T0 + 1 }));
    expect(rejection.code).toBe('invalid_request');
    expect(rejection.field).toBe('mailbox_text');
    expect(rejection.detail).toEqual({ length: 32769, limit: 32768 });
    const empty = rejectionOf(() => mailbox.post({ teamId: TEAM, from: W_ACP, to: W_CODEX, text: '', at: T0 + 2 }));
    expect(empty.field).toBe('mailbox_text');
    expect(mailbox.depth(TEAM)).toBe(1);
    mailbox.close();
  });

  it('close refuses a post with an explicit code', () => {
    const mailbox = mailboxModule.createMailbox();
    mailbox.openTeam({ teamId: TEAM, at: T0 });
    mailbox.addParticipant({ teamId: TEAM, participantId: W_ACP, at: T0 });
    mailbox.addParticipant({ teamId: TEAM, participantId: W_CODEX, at: T0 });
    mailbox.close();
    const rejection = rejectionOf(() => mailbox.post({ teamId: TEAM, from: W_ACP, to: W_CODEX, text: 'late', at: T0 }));
    expect(rejection.code).toBe('cancelled');
    expect(rejection.field).toBe('mailbox_closed');
  });
});

/* ------------------------------------------------------------------ late outcomes and termination propagation */

describe('late delegation outcomes and termination propagation', () => {
  it('a late deliver rejection cannot rewrite a terminal state written while the send was in flight', async () => {
    const gate: { reject?: () => void } = {};
    const deliver = (): Promise<{ readonly ackId: string }> => new Promise<{ readonly ackId: string }>((_resolve, reject) => {
      gate.reject = () => reject(new CollaborationError('source_unavailable', 'delegation_send'));
    });
    const service = makeService(deliver);
    const seed = seedTeam(service, ['acp']);
    // The send hangs in flight; the task is registered synchronously by the delegate prefix.
    const pending = seed.lead.scope.delegate({
      title: 'in flight', criteria: [CRITERION], workerParticipantId: W_ACP, at: T0 + 1,
    });
    const taskId = service.tasks(seed.team.teamId)[0]?.taskId ?? '';
    // The lead cancels the task while the send is still in flight.
    const cancelled = seed.lead.scope.control({ taskId, action: 'cancel', at: T0 + 2 });
    expect(cancelled.transitioned).toEqual([taskId]);
    expect(service.task(taskId).state).toBe('cancelled');
    // The hung send now rejects: the late failure must not rewrite the terminal state.
    gate.reject?.();
    const settled = await pending;
    expect(settled.state).toBe('cancelled');
    const view = service.task(taskId);
    expect(view.state).toBe('cancelled');
    expect(view.resolution).toEqual({ code: 'cancelled', field: 'delegation_cancel' });
    expect(view.endedBy).toEqual({ taskId, action: 'cancel', at: T0 + 2 });
    expect(view.endedAt).toBe(T0 + 2);
    expect(service.state().failed).toBe(0);
    service.close();
  });

  it('a late deliver result without an ack cannot rewrite a swept timeout', async () => {
    const gate: { resolve?: () => void } = {};
    const deliver = (): Promise<undefined> => new Promise<undefined>((resolve) => {
      gate.resolve = () => resolve(undefined);
    });
    const service = makeService(deliver);
    const seed = seedTeam(service, ['acp']);
    const pending = seed.lead.scope.delegate({
      title: 'slow work', criteria: [CRITERION], workerParticipantId: W_ACP, timeoutMs: 5000, at: T0,
    });
    const taskId = service.tasks(seed.team.teamId)[0]?.taskId ?? '';
    // The deadline sweep retires the task while the send is still in flight.
    const swept = service.sweep({ at: T0 + 5000 });
    expect(swept.timedOut).toEqual([taskId]);
    // The hung send now resolves WITHOUT an ack: the late ambiguous result is ignored.
    gate.resolve?.();
    const settled = await pending;
    expect(settled.state).toBe('timeout');
    const view = service.task(taskId);
    expect(view.state).toBe('timeout');
    expect(view.resolution).toEqual({ code: 'timeout', field: 'delegation_timeout' });
    expect(view.endedAt).toBe(T0 + 5000);
    expect(service.state().ambiguous).toBe(0);
    service.close();
  });

  it('cancelling an already-succeeded task never cascades to a running parent', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp', 'codex']);
    const parent = await seed.lead.scope.delegate({
      title: 'cascading parent', criteria: [CRITERION], workerParticipantId: W_ACP, childFailure: 'cascade', at: T0,
    });
    const child = await seed.lead.scope.delegate({
      title: 'succeeded child', criteria: [CRITERION], workerParticipantId: W_CODEX, parentTaskId: parent.taskId, at: T0 + 1,
    });
    await seed.workers[1]!.scope.submitEvidence({ taskId: child.taskId, outcome: 'succeeded', evidence: [EVIDENCE], at: T0 + 2 });
    expect(service.task(child.taskId).state).toBe('succeeded');
    // The lead cancels the already-succeeded child: nothing transitions, so nothing cascades.
    const result = seed.lead.scope.control({ taskId: child.taskId, action: 'cancel', at: T0 + 3 });
    expect(result.transitioned).toEqual([]);
    expect(result.skipped).toEqual([child.taskId]);
    expect(service.task(child.taskId).state).toBe('succeeded');
    const parentView = service.task(parent.taskId);
    expect(parentView.state).toBe('delegated');
    expect(parentView.endedBy).toBeNull();
    expect(parentView.endedAt).toBeNull();
    expect(service.state().cancelled).toBe(0);
    expect(service.state().inFlight).toBe(1);
    service.close();
  });

  it('the deadline sweep cascades the timeout down the whole subtree', async () => {
    const service = makeService(ackAll);
    const seed = seedTeam(service, ['acp', 'codex']);
    const parent = await seed.lead.scope.delegate({
      title: 'parent with deadline', criteria: [CRITERION], workerParticipantId: W_ACP, timeoutMs: 5000, at: T0,
    });
    const child = await seed.lead.scope.delegate({
      title: 'child without deadline', criteria: [CRITERION], workerParticipantId: W_CODEX, parentTaskId: parent.taskId, at: T0 + 1,
    });
    expect(service.sweep({ at: T0 + 4999 }).count).toBe(0);
    const after = service.sweep({ at: T0 + 5000 });
    expect(after.timedOut).toEqual([parent.taskId, child.taskId]);
    expect(service.task(parent.taskId).state).toBe('timeout');
    const childView = service.task(child.taskId);
    expect(childView.state).toBe('timeout');
    expect(childView.endedBy).toEqual({ taskId: parent.taskId, action: 'timeout', at: T0 + 5000 });
    expect(childView.resolution).toEqual({ code: 'timeout', field: 'delegation_timeout' });
    expect(service.state().inFlight).toBe(0);
    // A later sweep finds nothing left to retire: the child never outlived the deadline.
    expect(service.sweep({ at: T0 + 6000 }).count).toBe(0);
    service.close();
  });

  it('a deliver failure propagates through the recorded childFailure policy', async () => {
    let codexFailed = false;
    const deliver = async (input: DelegationDeliverInput): Promise<{ readonly ackId: string }> => {
      if (input.participantId === W_CODEX && !codexFailed) {
        codexFailed = true;
        throw new CollaborationError('source_unavailable', 'delegation_send');
      }
      return { ackId: `ack-${input.taskId}` };
    };
    const service = makeService(deliver);
    const seed = seedTeam(service, ['acp', 'codex']);
    const parent = await seed.lead.scope.delegate({
      title: 'cascading parent', criteria: [CRITERION], workerParticipantId: W_ACP, childFailure: 'cascade', at: T0,
    });
    const failed = await seed.lead.scope.delegate({
      title: 'unreachable child', criteria: [CRITERION], workerParticipantId: W_CODEX, parentTaskId: parent.taskId, at: T0 + 1,
    });
    expect(failed.state).toBe('failed');
    expect(failed.resolution).toEqual({ code: 'source_unavailable', field: 'delegation_send' });
    const parentView = service.task(parent.taskId);
    expect(parentView.state).toBe('failed');
    expect(parentView.endedBy).toEqual({ taskId: failed.taskId, action: 'child-failed', at: T0 + 1 });
    expect(parentView.resolution).toEqual({ code: 'delegation_failed', field: 'delegation_child_failure' });
    service.close();
  });

  it('a deliver failure on an independent parent leaves the parent running', async () => {
    let codexFailed = false;
    const deliver = async (input: DelegationDeliverInput): Promise<{ readonly ackId: string }> => {
      if (input.participantId === W_CODEX && !codexFailed) {
        codexFailed = true;
        throw new CollaborationError('source_unavailable', 'delegation_send');
      }
      return { ackId: `ack-${input.taskId}` };
    };
    const service = makeService(deliver);
    const seed = seedTeam(service, ['acp', 'codex']);
    const parent = await seed.lead.scope.delegate({
      title: 'independent parent', criteria: [CRITERION], workerParticipantId: W_ACP, childFailure: 'independent', at: T0,
    });
    const failed = await seed.lead.scope.delegate({
      title: 'unreachable child', criteria: [CRITERION], workerParticipantId: W_CODEX, parentTaskId: parent.taskId, at: T0 + 1,
    });
    expect(failed.state).toBe('failed');
    const parentView = service.task(parent.taskId);
    expect(parentView.state).toBe('delegated');
    expect(parentView.endedBy).toBeNull();
    service.close();
  });
});
