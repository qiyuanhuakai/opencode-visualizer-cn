import { randomUUID } from 'node:crypto';
import {
  COLLABORATION_BUDGETS,
  CollaborationError,
  parseAt,
  parseMessageId,
  parseTeamId,
} from '../../../shared/runtime/collaboration.js';

/**
 * The persistent participant mailbox (task 39): the bidirectional notice channel a Lead/Worker
 * team's members exchange, carried across a restart by snapshot/rehydrate.
 *
 * Three guarantees are enforced by construction:
 *
 *   - SCOPE AUTHORIZATION is the registry itself. A team's participants are registered before any
 *     message exists; `post` and `messages` both resolve their participants through that registry,
 *     so a message can only ever travel between two members of the SAME team, and a read can only
 *     ever return messages addressed to or from the READING participant. There is no API that
 *     reads a team's traffic without naming a member.
 *   - PARENT CAUSALITY is checked BEFORE anything is written: a reply whose `parentMessageId` does
 *     not resolve inside the same team is refused and leaves the mailbox byte-identical.
 *   - The two bounds come from the one shared frozen contract: the MESSAGE COUNT is task 37's
 *     `COLLABORATION_BUDGETS.maxMailbox` itself (identity, not a second literal), and the per
 *     message size is this module's own 32 KiB bound.
 */

/** The one frozen limits object. The count is the shared budget; the size is this channel's own. */
export const MAILBOX_LIMITS = Object.freeze({
  maxMessages: COLLABORATION_BUDGETS.maxMailbox,
  maxMessageChars: 32768,
  maxParticipantChars: 128,
});

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

function parseParticipantId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAILBOX_LIMITS.maxParticipantChars
    || !UUID_PATTERN.test(value)) {
    throw new CollaborationError('invalid_request', 'mailbox_participant');
  }
  return value.toLowerCase();
}

function teamView(team) {
  return Object.freeze({
    teamId: team.teamId,
    participantCount: team.participants.size,
    messageCount: team.messages.length,
    createdAt: team.createdAt,
  });
}

/** The stored message IS the frozen read model: there is no second mutable copy to leak. */
function messageView(message) {
  return message;
}

function validateStoredMessage(value, teamId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 7
    || !Object.hasOwn(value, 'messageId') || !Object.hasOwn(value, 'teamId')
    || !Object.hasOwn(value, 'from') || !Object.hasOwn(value, 'to')
    || !Object.hasOwn(value, 'text') || !Object.hasOwn(value, 'parentMessageId')
    || !Object.hasOwn(value, 'at')) {
    throw new CollaborationError('invalid_request', 'mailbox_snapshot');
  }
  if (typeof value.messageId !== 'string' || !UUID_PATTERN.test(value.messageId)
    || typeof value.from !== 'string' || typeof value.to !== 'string'
    || typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAILBOX_LIMITS.maxMessageChars
    || (value.parentMessageId !== null && (typeof value.parentMessageId !== 'string' || !UUID_PATTERN.test(value.parentMessageId)))
    || typeof value.at !== 'number' || !Number.isSafeInteger(value.at) || value.at <= 0) {
    throw new CollaborationError('invalid_request', 'mailbox_snapshot');
  }
  if (parseTeamId(value.teamId) !== teamId) {
    throw new CollaborationError('invalid_request', 'mailbox_snapshot');
  }
  return Object.freeze({
    messageId: value.messageId.toLowerCase(),
    teamId,
    from: value.from,
    to: value.to,
    text: value.text,
    parentMessageId: value.parentMessageId === null ? null : value.parentMessageId.toLowerCase(),
    at: value.at,
  });
}

export function createMailbox() {
  /** teamId → { teamId, participants: Set, messages: frozen[], createdAt }. */
  const teamsById = new Map();
  let posted = 0;
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'mailbox_closed');
  }

  function requireTeam(teamId) {
    const team = teamsById.get(parseTeamId(teamId));
    if (team === undefined) throw new CollaborationError('invalid_request', 'mailbox_team', { teamId: parseTeamId(teamId) });
    return team;
  }

  function requireParticipant(team, participantId) {
    const id = parseParticipantId(participantId);
    if (!team.participants.has(id)) {
      throw new CollaborationError('unauthorized', 'mailbox_scope', { teamId: team.teamId, participantId: id });
    }
    return id;
  }

  function openTeam(input = {}) {
    assertOpen();
    const teamId = parseTeamId(input.teamId);
    const at = parseAt(input.at);
    if (teamsById.has(teamId)) throw new CollaborationError('conflict', 'mailbox_team', { teamId });
    const team = { teamId, participants: new Set(), messages: [], createdAt: at };
    teamsById.set(teamId, team);
    return teamView(team);
  }

  function team(teamId) {
    assertOpen();
    return teamView(requireTeam(teamId));
  }

  function teams() {
    assertOpen();
    return Object.freeze([...teamsById.values()].map(teamView));
  }

  function addParticipant(input = {}) {
    assertOpen();
    const teamRecord = requireTeam(input.teamId);
    const participantId = parseParticipantId(input.participantId);
    if (teamRecord.participants.has(participantId)) {
      throw new CollaborationError('conflict', 'mailbox_participant', { teamId: teamRecord.teamId, participantId });
    }
    teamRecord.participants.add(participantId);
    return Object.freeze({ teamId: teamRecord.teamId, participantId });
  }

  /**
   * Post one message. Every refusal happens BEFORE the write: an unknown team, a non-member
   * sender or recipient, an oversized or empty text, an unresolvable parent and a full mailbox
   * all leave the mailbox byte-identical.
   */
  function post(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'mailbox_input');
    }
    const team = requireTeam(input.teamId);
    const at = parseAt(input.at);
    const from = requireParticipant(team, input.from);
    const to = requireParticipant(team, input.to);
    const text = input.text;
    if (typeof text !== 'string' || text.length === 0 || text.length > MAILBOX_LIMITS.maxMessageChars) {
      throw new CollaborationError('invalid_request', 'mailbox_text', {
        length: typeof text === 'string' ? text.length : null,
        limit: MAILBOX_LIMITS.maxMessageChars,
      });
    }
    const parentMessageId = input.parentMessageId === undefined || input.parentMessageId === null
      ? null
      : parseMessageId(input.parentMessageId);
    if (parentMessageId !== null
      && !team.messages.some((message) => message.messageId === parentMessageId)) {
      throw new CollaborationError('invalid_request', 'mailbox_parent', { teamId: team.teamId, parentMessageId });
    }
    if (team.messages.length >= MAILBOX_LIMITS.maxMessages) {
      throw new CollaborationError('conflict', 'mailbox_full', {
        teamId: team.teamId,
        limit: MAILBOX_LIMITS.maxMessages,
        used: team.messages.length,
      });
    }
    const message = Object.freeze({
      messageId: randomUUID(),
      teamId: team.teamId,
      from,
      to,
      text,
      parentMessageId,
      at,
    });
    team.messages.push(message);
    posted += 1;
    return messageView(message);
  }

  /** The scope-authorized read: only messages addressed to or from THIS participant. */
  function messages(input = {}) {
    assertOpen();
    const team = requireTeam(input.teamId);
    const participantId = requireParticipant(team, input.participantId);
    return Object.freeze(team.messages
      .filter((message) => message.from === participantId || message.to === participantId)
      .map(messageView));
  }

  function depth(teamId) {
    return requireTeam(teamId).messages.length;
  }

  function snapshot() {
    return Object.freeze({
      version: 1,
      teams: Object.freeze([...teamsById.values()].map((team) => Object.freeze({
        teamId: team.teamId,
        createdAt: team.createdAt,
        participants: Object.freeze([...team.participants]),
        messages: Object.freeze([...team.messages]),
      }))),
    });
  }

  /** Restore a snapshot into a FRESH mailbox, re-validating every record on the way in. */
  function rehydrate(snapshotInput) {
    assertOpen();
    if (teamsById.size > 0) throw new CollaborationError('conflict', 'mailbox_team');
    if (snapshotInput === null || typeof snapshotInput !== 'object' || Array.isArray(snapshotInput)
      || snapshotInput.version !== 1 || !Array.isArray(snapshotInput.teams)) {
      throw new CollaborationError('invalid_request', 'mailbox_snapshot');
    }
    let participants = 0;
    let messages = 0;
    for (const teamSnapshot of snapshotInput.teams) {
      if (teamSnapshot === null || typeof teamSnapshot !== 'object' || Array.isArray(teamSnapshot)
        || Object.keys(teamSnapshot).length !== 4
        || !Object.hasOwn(teamSnapshot, 'teamId') || !Object.hasOwn(teamSnapshot, 'createdAt')
        || !Object.hasOwn(teamSnapshot, 'participants') || !Object.hasOwn(teamSnapshot, 'messages')
        || !Array.isArray(teamSnapshot.participants) || !Array.isArray(teamSnapshot.messages)
        || typeof teamSnapshot.createdAt !== 'number' || !Number.isSafeInteger(teamSnapshot.createdAt) || teamSnapshot.createdAt <= 0) {
        throw new CollaborationError('invalid_request', 'mailbox_snapshot');
      }
      const teamId = parseTeamId(teamSnapshot.teamId);
      if (teamsById.has(teamId)) throw new CollaborationError('conflict', 'mailbox_team', { teamId });
      const team = { teamId, participants: new Set(), messages: [], createdAt: teamSnapshot.createdAt };
      for (const participant of teamSnapshot.participants) team.participants.add(parseParticipantId(participant));
      for (const message of teamSnapshot.messages) {
        const restored = validateStoredMessage(message, teamId);
        if (restored.parentMessageId !== null
          && !team.messages.some((entry) => entry.messageId === restored.parentMessageId)) {
          throw new CollaborationError('invalid_request', 'mailbox_parent', { teamId, parentMessageId: restored.parentMessageId });
        }
        team.messages.push(restored);
      }
      teamsById.set(teamId, team);
      participants += team.participants.size;
      messages += team.messages.length;
    }
    posted += messages;
    return Object.freeze({ teams: teamsById.size, participants, messages });
  }

  function state() {
    let participants = 0;
    let messages = 0;
    for (const team of teamsById.values()) {
      participants += team.participants.size;
      messages += team.messages.length;
    }
    return Object.freeze({ teams: teamsById.size, participants, messages, posted, closed });
  }

  function close() {
    closed = true;
    teamsById.clear();
  }

  return {
    openTeam,
    team,
    teams,
    addParticipant,
    post,
    messages,
    depth,
    snapshot,
    rehydrate,
    state,
    close,
  };
}
