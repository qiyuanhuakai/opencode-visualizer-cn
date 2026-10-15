import { randomUUID } from 'node:crypto';
import { CollaborationError, parseAt } from '../../../shared/runtime/collaboration.js';
import { HARNESS_KINDS } from '../../../shared/runtime/harnessContract.js';

/**
 * Per-driver tool-injection capability (task 39): the temporary scoped tools a Lead/Worker team
 * exposes to its agents are injected ONLY into a driver whose native MCP surface accepts an
 * injection. A driver that cannot receive one gets the UI-only path, and that limitation is
 * recorded truthfully — this module never fabricates a capability a driver does not declare.
 *
 * Two rules are enforced by construction, following the harness contract's own doctrine
 * ("structural validation only; no support claim is inferred from a kind or version"):
 *
 *   - support is read from the DRIVER'S DECLARATION, never from its harness kind — a kimi-web
 *     driver that declares no injection is ui-only exactly like an acp one;
 *   - a driver that declares NOTHING fails closed to ui-only with an explicit limitation, so an
 *     unprobed driver can never be treated as injectable.
 */

/** The two injection modes. `native-mcp` injects; `ui-only` is dispatched by the Host UI. */
export const TOOL_INJECTION_MODES = Object.freeze(['native-mcp', 'ui-only']);

const MAX_LIMITATION_CHARS = 512;
const MAX_TOOL_NAME_CHARS = 128;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

function parseHarnessKind(value) {
  if (typeof value !== 'string' || !HARNESS_KINDS.includes(value)) {
    throw new CollaborationError('invalid_request', 'tool_capability_kind');
  }
  return value;
}

function parseLimitation(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LIMITATION_CHARS) {
    throw new CollaborationError('invalid_request', 'tool_injection_declaration');
  }
  return value;
}

/**
 * Detect one driver's injection mode from its declaration. A missing declaration fails CLOSED to
 * ui-only; a malformed one is an explicit rejection rather than a guess.
 */
export function detectToolInjection(input = {}) {
  if (input === null || typeof input !== 'object') {
    throw new CollaborationError('invalid_request', 'tool_injection_input');
  }
  const harnessKind = parseHarnessKind(input.harnessKind);
  const declaration = input.toolInjection;
  if (declaration === undefined || declaration === null) {
    return Object.freeze({
      harnessKind,
      mode: 'ui-only',
      injectable: false,
      limitation: 'driver declares no tool-injection support',
    });
  }
  if (typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new CollaborationError('invalid_request', 'tool_injection_declaration');
  }
  if (declaration.state === 'supported') {
    if (Object.keys(declaration).length !== 1) {
      throw new CollaborationError('invalid_request', 'tool_injection_declaration');
    }
    return Object.freeze({ harnessKind, mode: 'native-mcp', injectable: true, limitation: null });
  }
  if (declaration.state === 'unsupported') {
    if (Object.keys(declaration).length !== 3 || declaration.code !== 'unsupported') {
      throw new CollaborationError('invalid_request', 'tool_injection_declaration');
    }
    return Object.freeze({
      harnessKind,
      mode: 'ui-only',
      injectable: false,
      limitation: parseLimitation(declaration.reason),
    });
  }
  throw new CollaborationError('invalid_request', 'tool_injection_declaration');
}

function parseUuid(value, reason) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new CollaborationError('invalid_request', reason);
  }
  return value.toLowerCase();
}

function parseToolName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOOL_NAME_CHARS) {
    throw new CollaborationError('invalid_request', 'tool_name');
  }
  return value;
}

function parseToolScope(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'teamId') || !Object.hasOwn(value, 'participantId')) {
    throw new CollaborationError('invalid_request', 'tool_scope');
  }
  return Object.freeze({
    teamId: parseUuid(value.teamId, 'tool_scope'),
    participantId: parseUuid(value.participantId, 'tool_scope'),
  });
}

function toolView(record) {
  return Object.freeze({
    toolId: record.toolId,
    harnessKind: record.harnessKind,
    name: record.name,
    scope: record.scope,
    revoked: record.revoked,
    createdAt: record.createdAt,
  });
}

/**
 * The capability registry: one entry per registered driver kind, plus the temporary scoped tools
 * those drivers hold. A scoped tool exists only while its driver's capability is `native-mcp` and
 * it has not been revoked — registration and revocation are the ONLY writers, so a ui-only driver
 * structurally cannot hold one.
 */
export function createToolCapabilityRegistry() {
  /** harnessKind → the frozen capability view. */
  const capabilities = new Map();
  /** toolId → the frozen tool record. */
  const toolsById = new Map();
  /** composite key → the ACTIVE toolId, deleted on revoke. */
  const activeByKey = new Map();
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'tool_capability_closed');
  }

  function keyOf(harnessKind, name, scope) {
    return `${harnessKind}\u0000${name}\u0000${scope.teamId}\u0000${scope.participantId}`;
  }

  function register(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object' || input.toolInjection === undefined || input.toolInjection === null) {
      throw new CollaborationError('invalid_request', 'tool_injection_declaration');
    }
    const view = detectToolInjection(input);
    if (capabilities.has(view.harnessKind)) {
      throw new CollaborationError('conflict', 'tool_capability_duplicate', { harnessKind: view.harnessKind });
    }
    capabilities.set(view.harnessKind, view);
    return view;
  }

  function has(harnessKind) {
    return capabilities.has(parseHarnessKind(harnessKind));
  }

  function capability(harnessKind) {
    const view = capabilities.get(parseHarnessKind(harnessKind));
    if (view === undefined) throw new CollaborationError('invalid_request', 'tool_capability_unknown', { harnessKind });
    return view;
  }

  function capabilities_() {
    assertOpen();
    return Object.freeze([...capabilities.values()]);
  }

  /**
   * Register a temporary scoped tool. The driver's capability is consulted FIRST: a driver that is
   * not `native-mcp` is refused with its real limitation, so no tool is ever injected into a driver
   * that cannot receive one. Re-registering the same tool for the same scope is idempotent.
   */
  function registerScopedTool(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'tool_input');
    }
    const harnessKind = parseHarnessKind(input.harnessKind);
    const name = parseToolName(input.name);
    const scope = parseToolScope(input.scope);
    const at = parseAt(input.at);
    const registered = capabilities.get(harnessKind);
    const view = registered ?? detectToolInjection({ harnessKind });
    if (view.mode !== 'native-mcp') {
      throw new CollaborationError('unsupported', 'tool_injection_unavailable', {
        harnessKind,
        mode: view.mode,
        limitation: view.limitation,
      });
    }
    const key = keyOf(harnessKind, name, scope);
    const existing = activeByKey.get(key);
    if (existing !== undefined) return toolView(toolsById.get(existing));
    const record = Object.freeze({ toolId: randomUUID(), harnessKind, name, scope, revoked: false, createdAt: at });
    toolsById.set(record.toolId, record);
    activeByKey.set(key, record.toolId);
    return toolView(record);
  }

  function revokeScopedTool(toolId) {
    assertOpen();
    const id = parseUuid(toolId, 'tool_id');
    const record = toolsById.get(id);
    if (record === undefined) throw new CollaborationError('invalid_request', 'tool_unknown', { toolId: id });
    if (record.revoked) return toolView(record);
    const revoked = Object.freeze({ ...record, revoked: true });
    toolsById.set(id, revoked);
    activeByKey.delete(keyOf(revoked.harnessKind, revoked.name, revoked.scope));
    return toolView(revoked);
  }

  /** The ACTIVE tool for this driver/name/scope, or null when none is registered or it was revoked. */
  function activeTool(harnessKind, name, scope) {
    const toolId = activeByKey.get(keyOf(parseHarnessKind(harnessKind), parseToolName(name), parseToolScope(scope)));
    if (toolId === undefined) return null;
    return toolView(toolsById.get(toolId));
  }

  function scopedTools(input = {}) {
    assertOpen();
    const wanted = input?.harnessKind === undefined ? null : parseHarnessKind(input.harnessKind);
    return Object.freeze([...toolsById.values()]
      .filter((record) => wanted === null || record.harnessKind === wanted)
      .map(toolView));
  }

  function state() {
    return Object.freeze({
      registered: capabilities.size,
      active: activeByKey.size,
      revoked: [...toolsById.values()].filter((record) => record.revoked).length,
      closed,
    });
  }

  function close() {
    closed = true;
    capabilities.clear();
    toolsById.clear();
    activeByKey.clear();
  }

  return {
    register,
    has,
    capability,
    capabilities: capabilities_,
    registerScopedTool,
    revokeScopedTool,
    activeTool,
    scopedTools,
    state,
    close,
  };
}
