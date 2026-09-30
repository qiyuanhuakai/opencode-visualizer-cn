/**
 * dsh permission presets + approval waterfall → the shared permission UI
 * (plan Todo 28; dsh web 0.2.0-rc.2, docs/dsh.md §8.2/§8.3, §9).
 *
 * This module is the seam between the landed Todo 19 bridge and the existing
 * `usePermissions` window. It owns two things:
 *
 *   1. A READ-ONLY preset model. The real session events `permission/preset`
 *      `{preset}`, `sandbox/mode` `{mode}`, `approval/policy` `{policy}`, the
 *      snapshot header `agentPreset` and the `permissions.currentValue`
 *      projection drive it. No preset write endpoint was probed for
 *      0.2.0-rc.2 (review blocker #6), so `selector.writable` is always false
 *      and `selectPreset` refuses — this surface emits NO mutation request.
 *
 *   2. The approval waterfall bridge→UI→answer path. An `approval/request`
 *      frame opens a `PermissionRequest`; the user's `once`/`always`/`reject`
 *      reply is mapped onto dsh's EXACT outcome vocabulary and answered over
 *      `POST /dsh/$events/result` (via the bridge's `resolveApproval` /
 *      `rejectApproval`, never a new endpoint).
 *
 * dsh's outcome vocabulary (verified in the 0.2.0-rc.2 source, not guessed):
 * `@deepseek-ai/dsh-client-ui-approval` returns the approval strings
 * `"allowed-once"` / `"rejected"`, and `@deepseek-ai/dsh-api-gateway`'s
 * `dispatchWaterfall` wraps a listener return value as `{kind:"result", value}`.
 * The envelope kind `{kind:"rejected"}` is the gateway's listener-FAILURE shape
 * (the approval service then fails closed to `"unavailable"`), which is exactly
 * the terminal safe answer used when the UI cannot be shown. A silently dropped
 * frame would hang the agent turn forever (docs/dsh.md:368, review blocker #7).
 */
import { computed, reactive, type ComputedRef } from 'vue';

import type { DshNormalizeOp } from '../backends/dsh/ops';
import type { PermissionRequest } from './usePermissions';
import type {
  DshApprovalRequest,
  DshMessageBridge,
  DshWaterfallOutcome,
} from './dshMessageBridgeTypes';

export const DSH_APPROVAL_REQUEST_PREFIX = 'dsh-approval:';
export const DSH_APPROVAL_ALLOWED_ONCE = 'allowed-once';
export const DSH_APPROVAL_REJECTED = 'rejected';

/** Protocol-native permission preset names (dsh-permission-presets). */
export const DSH_PERMISSION_PRESET_CATALOG = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;

const DSH_APPROVAL_UI_DEGRADED =
  'dsh: approval UI is unavailable; the request was declined so the turn is not left hanging';

export type DshPermissionPresetState = {
  agentPreset: string;
  permissionPreset: string;
  sandboxMode: string;
  approvalPolicy: string;
};

export type DshPresetSelector = {
  current: string;
  options: readonly string[];
  writable: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function dshSafeRejection(message: string): DshWaterfallOutcome {
  return {
    kind: 'rejected',
    error: { name: 'DshWaterfallRejected', message, code: 'DSH_WATERFALL_SAFE_REJECTION' },
  };
}

/** Map a permission-window reply onto dsh's approval outcome value. */
export function dshApprovalOutcomeFromReply(reply: string): DshWaterfallOutcome {
  if (reply === 'reject') return { kind: 'result', value: DSH_APPROVAL_REJECTED };
  if (reply === 'once' || reply === 'always') {
    return { kind: 'result', value: DSH_APPROVAL_ALLOWED_ONCE };
  }
  return dshSafeRejection(
    `dsh: unknown approval reply ${JSON.stringify(reply)}; the request was declined so the turn is not left hanging`,
  );
}

export function dshApprovalRequestId(eventId: string): string {
  return `${DSH_APPROVAL_REQUEST_PREFIX}${eventId}`;
}

export function parseDshApprovalRequestId(requestId: string): string | null {
  if (!requestId.startsWith(DSH_APPROVAL_REQUEST_PREFIX)) return null;
  const eventId = requestId.slice(DSH_APPROVAL_REQUEST_PREFIX.length);
  return eventId.length > 0 ? eventId : null;
}

/** Shape a `waterfall` approval frame as the shared permission window request. */
export function dshApprovalToPermissionRequest(request: DshApprovalRequest): PermissionRequest {
  const payload = isRecord(request.request) ? request.request : {};
  const toolName = nonEmptyString(payload.toolName) ?? 'approval';
  const callId = nonEmptyString(payload.callId);
  const reason = nonEmptyString(payload.reason);
  const displayReason = isRecord(payload.displayReason) ? payload.displayReason : undefined;
  const metadata: Record<string, unknown> = {};
  if (reason) metadata.reason = reason;
  if (displayReason) metadata.displayReason = displayReason;
  return {
    id: dshApprovalRequestId(request.eventId),
    sessionID: request.sessionId || 'dsh',
    permission: toolName,
    patterns: [],
    metadata,
    always: [],
    ...(callId ? { tool: { messageID: callId, callID: callId } } : {}),
  };
}

export type DshApprovalResponseSurface = Pick<
  DshMessageBridge,
  | 'resolveApproval'
  | 'rejectApproval'
  | 'rejectAllApprovals'
  | 'pendingApprovals'
  | 'subscribeApprovals'
>;

export type DshPermissionsOptions = {
  approvalUiEnabled?: boolean;
  openPermissionWindow?: (request: PermissionRequest) => void;
  closePermissionWindow?: (requestId: string) => void;
  onPresetStateChange?: (state: DshPermissionPresetState) => void;
  onApprovalSurfaceUnavailable?: (eventId: string, reason: string) => void;
};

export type DshPermissions = {
  readonly state: DshPermissionPresetState;
  readonly selector: ComputedRef<DshPresetSelector>;
  readonly permissionPresetOptions: readonly string[];
  ingestEvent(eventType: string, data: unknown): boolean;
  ingestPolicyOp(op: Extract<DshNormalizeOp, { kind: 'policy' }>): boolean;
  ingestSnapshotHeader(header: unknown): boolean;
  ingestProjections(values: unknown): boolean;
  ingestSnapshot(value: unknown): boolean;
  handleSessionEvent(op: DshNormalizeOp): void;
  selectPreset(preset: string): boolean;
  attach(bridge: DshApprovalResponseSurface): void;
  onApprovalRequest(request: DshApprovalRequest): void;
  replyToPermission(requestId: string, reply: string): void;
  setApprovalUiEnabled(enabled: boolean): void;
  isApprovalUiEnabled(): boolean;
  pendingPermissionRequestIds(): readonly string[];
};

export function createDshPermissions(options: DshPermissionsOptions = {}): DshPermissions {
  const state = reactive<DshPermissionPresetState>({
    agentPreset: '',
    permissionPreset: '',
    sandboxMode: '',
    approvalPolicy: '',
  });

  const selector: ComputedRef<DshPresetSelector> = computed(() => ({
    current: state.permissionPreset,
    options: DSH_PERMISSION_PRESET_CATALOG,
    writable: false,
  }));

  let approvalUiEnabled = options.approvalUiEnabled ?? true;
  let bridge: DshApprovalResponseSurface | undefined;
  let unsubscribe: (() => void) | undefined;
  const pendingWindows = new Map<string, string>();

  function notifyPreset(): void {
    options.onPresetStateChange?.({ ...state });
  }

  function setField(field: keyof DshPermissionPresetState, value: string | undefined): boolean {
    if (value === undefined || state[field] === value) return false;
    state[field] = value;
    notifyPreset();
    return true;
  }

  function ingestEvent(eventType: string, data: unknown): boolean {
    switch (eventType) {
      case 'permission/preset':
        return setField(
          'permissionPreset',
          nonEmptyString(isRecord(data) ? data.preset : undefined) ??
            nonEmptyString(isRecord(data) ? data.agentPreset : undefined),
        );
      case 'sandbox/mode':
        return setField('sandboxMode', nonEmptyString(isRecord(data) ? data.mode : undefined));
      case 'approval/policy':
        return setField('approvalPolicy', nonEmptyString(isRecord(data) ? data.policy : undefined));
      case 'agent-preset/selected':
        return setField(
          'agentPreset',
          nonEmptyString(isRecord(data) ? data.agentPreset : undefined),
        );
      default:
        return false;
    }
  }

  function ingestPolicyOp(op: Extract<DshNormalizeOp, { kind: 'policy' }>): boolean {
    switch (op.policy) {
      case 'permission-preset':
        return setField('permissionPreset', nonEmptyString(op.value));
      case 'sandbox-mode':
        return setField('sandboxMode', nonEmptyString(op.value));
      case 'approval-policy':
        return setField('approvalPolicy', nonEmptyString(op.value));
      default:
        return false;
    }
  }

  function ingestSnapshotHeader(header: unknown): boolean {
    return setField(
      'agentPreset',
      nonEmptyString(isRecord(header) ? header.agentPreset : undefined),
    );
  }

  function ingestProjections(values: unknown): boolean {
    if (!isRecord(values)) return false;
    let changed = setField('agentPreset', nonEmptyString(values.agentPreset));
    const permissions = isRecord(values.permissions) ? values.permissions : undefined;
    if (permissions && setField('permissionPreset', nonEmptyString(permissions.currentValue))) {
      changed = true;
    }
    return changed;
  }

  function ingestSnapshot(value: unknown): boolean {
    if (!isRecord(value)) return false;
    let changed = ingestSnapshotHeader(value.header);
    const projections = isRecord(value.projections) ? value.projections : undefined;
    const projectionValues = projections && isRecord(projections.values) ? projections.values : projections;
    if (projectionValues && ingestProjections(projectionValues)) changed = true;
    return changed;
  }

  function handleSessionEvent(op: DshNormalizeOp): void {
    if (op.kind === 'policy') ingestPolicyOp(op);
  }

  function selectPreset(_preset: string): boolean {
    return false;
  }

  function handleApprovalRequest(request: DshApprovalRequest): void {
    if (nonEmptyString(request?.eventId) === undefined) return;
    if (!approvalUiEnabled || options.openPermissionWindow === undefined) {
      bridge?.rejectApproval(request.eventId, DSH_APPROVAL_UI_DEGRADED);
      options.onApprovalSurfaceUnavailable?.(
        request.eventId,
        approvalUiEnabled ? 'no-permission-window' : 'approval-ui-disabled',
      );
      return;
    }
    const mapped = dshApprovalToPermissionRequest(request);
    pendingWindows.set(mapped.id, request.eventId);
    options.openPermissionWindow(mapped);
  }

  function replyToPermission(requestId: string, reply: string): void {
    const eventId = pendingWindows.get(requestId);
    if (eventId === undefined) return;
    pendingWindows.delete(requestId);
    bridge?.resolveApproval(eventId, dshApprovalOutcomeFromReply(reply));
    options.closePermissionWindow?.(requestId);
  }

  function setApprovalUiEnabled(enabled: boolean): void {
    approvalUiEnabled = enabled;
    if (enabled) return;
    for (const [requestId, eventId] of [...pendingWindows]) {
      pendingWindows.delete(requestId);
      bridge?.rejectApproval(eventId, DSH_APPROVAL_UI_DEGRADED);
      options.closePermissionWindow?.(requestId);
    }
  }

  function attach(next: DshApprovalResponseSurface): void {
    bridge = next;
    unsubscribe?.();
    unsubscribe = next.subscribeApprovals((request) => handleApprovalRequest(request));
  }

  return {
    state,
    selector,
    permissionPresetOptions: DSH_PERMISSION_PRESET_CATALOG,
    ingestEvent,
    ingestPolicyOp,
    ingestSnapshotHeader,
    ingestProjections,
    ingestSnapshot,
    handleSessionEvent,
    selectPreset,
    attach,
    onApprovalRequest: handleApprovalRequest,
    replyToPermission,
    setApprovalUiEnabled,
    isApprovalUiEnabled: () => approvalUiEnabled,
    pendingPermissionRequestIds: () => [...pendingWindows.keys()],
  };
}
