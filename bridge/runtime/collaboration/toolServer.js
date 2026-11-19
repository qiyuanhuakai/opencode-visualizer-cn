import { CollaborationError } from '../../../shared/runtime/collaboration.js';
import { createToolCapabilityRegistry, detectToolInjection } from './toolCapabilities.js';

/**
 * The Team tool contract (task 39): five standard tools — delegate, status, message, evidence,
 * control — dispatched through the delegation service under each caller's role scope.
 *
 * Two guarantees are enforced by construction:
 *
 *   - THE ROLE TABLE IS THE CONTRACT. A tool is callable only by the roles its frozen descriptor
 *     names, and the caller is identified by a scope handle the delegation service minted — a
 *     forged object resolves to nothing and is refused before any routing happens.
 *
 *   - THE UI-ONLY LIMITATION IS REAL, NEVER FAKED. A native call requires the caller's driver to
 *     declare tool injection AND to hold an active scoped tool for that exact tool; otherwise the
 *     call is refused with the driver's OWN recorded limitation, and the availability read model
 *     reports `nativeCallable: false` for every tool. The Host UI path (`callFromUi`) runs the
 *     SAME scope checks and the SAME service operations — it is a delivery channel, not a scope
 *     bypass — and is the honest way a ui-only driver's work gets done.
 */
export const TEAM_TOOLS = Object.freeze([
  Object.freeze({ name: 'delegate', roles: Object.freeze(['lead']) }),
  Object.freeze({ name: 'status', roles: Object.freeze(['lead', 'worker']) }),
  Object.freeze({ name: 'message', roles: Object.freeze(['lead', 'worker']) }),
  Object.freeze({ name: 'evidence', roles: Object.freeze(['lead', 'worker']) }),
  Object.freeze({ name: 'control', roles: Object.freeze(['lead']) }),
]);

const TOOLS_BY_NAME = new Map(TEAM_TOOLS.map((tool) => [tool.name, tool]));

export function createToolServer({ delegation, capabilities: injectedCapabilities } = {}) {
  if (delegation === null || typeof delegation !== 'object'
    || typeof delegation.resolveScope !== 'function' || typeof delegation.member !== 'function') {
    throw new CollaborationError('invalid_request', 'tool_server_delegation');
  }
  const capabilities = injectedCapabilities ?? createToolCapabilityRegistry();
  /** memberId → the frozen attachment (mode, limitation, the active scoped tool ids). */
  const attachments = new Map();
  const stats = { nativeCalls: 0, uiCalls: 0, refused: 0 };
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'tool_server_closed');
  }

  /** The driver's capability, failing CLOSED to ui-only when it was never registered. */
  function capabilityOf(member) {
    return capabilities.has(member.harnessKind)
      ? capabilities.capability(member.harnessKind)
      : detectToolInjection({ harnessKind: member.harnessKind });
  }

  function tools() {
    return TEAM_TOOLS;
  }

  function registerDriver(input = {}) {
    assertOpen();
    return capabilities.register(input);
  }

  /**
   * Attach a participant: a native-mcp driver receives the five TEMPORARY scoped tools, a ui-only
   * driver receives nothing and its real limitation is recorded. Idempotent per participant.
   */
  function attach(input = {}) {
    assertOpen();
    const resolved = delegation.resolveScope(input.scope);
    const member = delegation.member(resolved.memberId);
    const capability = capabilityOf(member);
    const registered = [];
    if (capability.mode === 'native-mcp') {
      for (const tool of TEAM_TOOLS) {
        const scoped = capabilities.registerScopedTool({
          harnessKind: member.harnessKind,
          name: tool.name,
          scope: { teamId: member.teamId, participantId: member.participantId },
        });
        registered.push(Object.freeze({ name: tool.name, toolId: scoped.toolId }));
      }
    }
    const attachment = Object.freeze({
      participantId: member.participantId,
      harnessKind: member.harnessKind,
      mode: capability.mode,
      injectable: capability.injectable,
      limitation: capability.limitation,
      tools: Object.freeze(registered),
    });
    attachments.set(member.memberId, attachment);
    return attachment;
  }

  /** Detach a participant: every scoped tool it held is revoked. Temporary means revocable. */
  function detach(input = {}) {
    assertOpen();
    const resolved = delegation.resolveScope(input.scope);
    const attachment = attachments.get(resolved.memberId);
    if (attachment === undefined) {
      return Object.freeze({ participantId: resolved.participantId, revoked: Object.freeze([]) });
    }
    const revoked = [];
    for (const tool of attachment.tools) {
      capabilities.revokeScopedTool(tool.toolId);
      revoked.push(tool.name);
    }
    attachments.delete(resolved.memberId);
    return Object.freeze({ participantId: attachment.participantId, revoked: Object.freeze(revoked) });
  }

  /**
   * The truthful availability read model: what each tool REALLY is for this participant. A ui-only
   * driver shows `nativeCallable: false` with its own limitation on every tool; it never shows a
   * callable native tool it does not have.
   */
  function availability(input = {}) {
    assertOpen();
    const resolved = delegation.resolveScope(input.scope);
    const member = delegation.member(resolved.memberId);
    const capability = capabilityOf(member);
    const attachment = attachments.get(resolved.memberId);
    const activeNames = new Set((attachment?.tools ?? []).map((tool) => tool.name));
    return Object.freeze({
      participantId: member.participantId,
      harnessKind: member.harnessKind,
      mode: capability.mode,
      limitation: capability.limitation,
      tools: Object.freeze(TEAM_TOOLS.map((tool) => Object.freeze({
        name: tool.name,
        nativeCallable: capability.mode === 'native-mcp' && activeNames.has(tool.name),
        uiDispatchable: true,
        roles: tool.roles,
      }))),
    });
  }

  function route(name, scope, resolved, params) {
    const input = params === null || params === undefined ? {} : params;
    switch (name) {
      case 'delegate':
        return delegation.delegate(scope, input);
      case 'status':
        return delegation.status(scope, input);
      case 'message':
        return delegation.message(scope, input);
      case 'evidence':
        // The same tool name routes by ROLE: a lead reads evidence, a worker submits it.
        return resolved.role === 'lead'
          ? delegation.readEvidence(scope, input)
          : delegation.submitEvidence(scope, input);
      default:
        return delegation.control(scope, input);
    }
  }

  async function dispatch(input, channel) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'tool_input');
    }
    const resolved = delegation.resolveScope(input.scope);
    const tool = TOOLS_BY_NAME.get(input.tool);
    if (tool === undefined) {
      stats.refused += 1;
      throw new CollaborationError('invalid_request', 'tool_unknown', {
        tool: typeof input.tool === 'string' ? input.tool : null,
      });
    }
    if (!tool.roles.includes(resolved.role)) {
      stats.refused += 1;
      throw new CollaborationError('unauthorized', 'tool_scope', { tool: tool.name, role: resolved.role });
    }
    if (channel === 'native') {
      const member = delegation.member(resolved.memberId);
      const capability = capabilityOf(member);
      if (capability.mode !== 'native-mcp') {
        // The tool must NOT pretend to be callable: the refusal carries the driver's real
        // limitation, and the Host UI path remains the honest delivery channel.
        stats.refused += 1;
        throw new CollaborationError('unsupported', 'tool_ui_only', {
          participantId: member.participantId,
          harnessKind: member.harnessKind,
          mode: capability.mode,
          limitation: capability.limitation,
        });
      }
      const active = capabilities.activeTool(member.harnessKind, tool.name, {
        teamId: member.teamId,
        participantId: member.participantId,
      });
      if (active === null) {
        stats.refused += 1;
        throw new CollaborationError('unsupported', 'tool_injection_inactive', {
          participantId: member.participantId,
          harnessKind: member.harnessKind,
          name: tool.name,
        });
      }
      stats.nativeCalls += 1;
    } else {
      stats.uiCalls += 1;
    }
    return route(tool.name, input.scope, resolved, input.params);
  }

  function call(input = {}) {
    return dispatch(input, 'native');
  }

  function callFromUi(input = {}) {
    return dispatch(input, 'ui');
  }

  function state() {
    return Object.freeze({
      tools: TEAM_TOOLS.length,
      nativeCalls: stats.nativeCalls,
      uiCalls: stats.uiCalls,
      refused: stats.refused,
      attached: attachments.size,
      closed,
    });
  }

  function close() {
    closed = true;
    attachments.clear();
    capabilities.close();
  }

  return {
    tools,
    registerDriver,
    attach,
    detach,
    availability,
    call,
    callFromUi,
    state,
    close,
  };
}
