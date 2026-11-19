import { classifyDesktopBridgeEndpoint } from './useDesktopBridgeVersion';
import type { DesktopBridgeEndpointLocality } from '../types/desktop';

/**
 * Task 24 — the workspace capability decision every local-only workspace
 * action consults before it runs.
 *
 * A workspace action is authorized for a target only when the target's bridge
 * endpoint is local. The bridge speaks `ws://` to the UI and `http(s)` to the
 * health probe, so both forms are classified; `classifyDesktopBridgeEndpoint`
 * consumes the http form and the ws form is derived through the same shared
 * helper the health probe uses.
 *
 * A remote path is NEVER handed to the local shell or the local editor: the
 * three local-only actions below are refused for a remote endpoint, which is
 * the plan's acceptance criterion as a pure decision.
 */
export type LocalOnlyWorkspaceAction = 'localShell' | 'localEditor' | 'localApplication';

export type WorkspaceCapabilityDecision = Readonly<{
  /** The target's endpoint locality. */
  locality: DesktopBridgeEndpointLocality;
  /** Whether the action is authorized for that target. */
  authorized: boolean;
  /** The reason the action was refused, for the UI to render next to the control. */
  reason: 'local-only-action' | 'unknown-endpoint' | null;
}>;

const LOCAL_ONLY_ACTIONS: ReadonlySet<LocalOnlyWorkspaceAction> = new Set<LocalOnlyWorkspaceAction>([
  'localShell',
  'localEditor',
  'localApplication',
]);

/** Whether an action must only ever run on the local machine. */
export function isLocalOnlyWorkspaceAction(action: string): action is LocalOnlyWorkspaceAction {
  return LOCAL_ONLY_ACTIONS.has(action as LocalOnlyWorkspaceAction);
}

/**
 * Classify a bridge endpoint the UI is connected to, accepting the ws:// form
 * the UI holds as well as the http(s) form the health probe uses. The ws form
 * is rewritten to the http form the classifier consumes, so a remote bridge is
 * classified remotely by every path that reaches it.
 */
export function bridgeEndpointLocality(url: string): DesktopBridgeEndpointLocality {
  const trimmed = url.trim();
  if (!trimmed) return 'unknown';
  if (trimmed.startsWith('ws://')) {
    return classifyDesktopBridgeEndpoint(`http://${trimmed.slice('ws://'.length)}`);
  }
  if (trimmed.startsWith('wss://')) {
    return classifyDesktopBridgeEndpoint(`https://${trimmed.slice('wss://'.length)}`);
  }
  return classifyDesktopBridgeEndpoint(trimmed);
}

/**
 * Decide whether a workspace action may run against a target. A local-only
 * action is authorized only when the target's endpoint is local; every other
 * action is authorized for any reachable endpoint.
 */
export function decideWorkspaceCapability(
  action: string,
  bridgeUrl: string,
): WorkspaceCapabilityDecision {
  const locality = bridgeEndpointLocality(bridgeUrl);
  if (!isLocalOnlyWorkspaceAction(action)) {
    return { locality, authorized: true, reason: null };
  }
  if (locality === 'local') {
    return { locality, authorized: true, reason: null };
  }
  if (locality === 'remote') {
    return { locality, authorized: false, reason: 'local-only-action' };
  }
  return { locality, authorized: false, reason: 'unknown-endpoint' };
}
