import { objectFields, requireValue, jsonValue } from './capabilities.js';

export const HOST_OPERATIONS = Object.freeze({
  thread: Object.freeze({
    read: ['selection', 'manifest', 'repository', 'snapshot', 'handoffs', 'participants', 'resolveSession', 'timeline', 'get', 'history', 'active', 'nativeHistory', 'state'],
    mutate: ['bind', 'join', 'leave', 'resume', 'activate'],
  }),
  handoff: Object.freeze({
    read: ['handoff', 'handoffs', 'ops', 'checkpoint', 'evidenceTarget', 'evidencePage'],
    mutate: ['begin', 'attach', 'prepare', 'deliver', 'cancel', 'resolve', 'captureEvidence'],
  }),
  collaboration: Object.freeze({
    read: [
      'team',
      'teams',
      'task',
      'taskDetails',
      'tasks',
      'attempt',
      'attempts',
      'ops',
      'mailbox',
      'budgets',
      'state',
      'snapshot',
      'teamForThread',
      'members',
      'membersPage',
      'delegationTask',
      'delegationTasks',
      'readEvidence',
      'delegationStatus',
    ],
    mutate: [
      'openTeam',
      'createTeam',
      'createTask',
      'addDependency',
      'dispatch',
      'send',
      'pump',
      'cancelAttempt',
      'registerDeliverable',
      'submitForReview',
      'review',
      'accept',
      'reject',
      'failTask',
      'cancelTask',
      'postMessage',
      'addMember',
      'delegate',
      'submitEvidence',
      'message',
      'control',
    ],
  }),
  fanout: Object.freeze({
    read: ['fanout', 'fanouts', 'fanoutsPage', 'state'],
    mutate: ['createFanout', 'dispatch', 'cancelRecipient', 'reconcile', 'retry'],
  }),
  writer: Object.freeze({
    read: ['binding', 'lease', 'leases', 'nativeCwd', 'posture', 'retention', 'state'],
    mutate: [
      'allocate',
      'reconcile',
      'reconnect',
      'release',
      'confirmWorktreeRemoval',
      'removeWorktree',
    ],
  }),
  artifact: Object.freeze({
    read: ['inspect', 'workflow', 'entries', 'content', 'review', 'approval', 'integration'],
    mutate: ['capture', 'apply', 'review', 'approve', 'integrate'],
  }),
  migration: Object.freeze({ read: [], mutate: ['accept', 'verify'] }),
  remote: Object.freeze({
    read: ['capabilities', 'preview', 'identity', 'profiles', 'status', 'challenges', 'jobs', 'job'],
    mutate: [
      'create',
      'update',
      'enable',
      'connect',
      'reconnect',
      'disconnect',
      'delete',
      'respond',
      'submit',
      'borrow',
      'reconcile',
      'detach',
      'stop',
    ],
  }),
});
export function parseHostCall(mode, input) {
  const value = objectFields(jsonValue(input), ['domain', 'operation', 'args']);
  requireValue(mode === 'read' || mode === 'mutate', 'host.mode');
  requireValue(
    Object.hasOwn(HOST_OPERATIONS, value.domain) &&
      HOST_OPERATIONS[value.domain][mode].includes(value.operation),
    'host.operation',
    'unsupported',
  );
  requireValue(
    value.args !== null && typeof value.args === 'object' && !Array.isArray(value.args),
    'host.args',
  );
  for (const key of ['permissions', 'epoch', 'processGeneration', 'idempotencyKey', 'grant'])
    requireValue(!Object.hasOwn(value.args, key), 'host.authority', 'unauthorized');
  return value;
}
