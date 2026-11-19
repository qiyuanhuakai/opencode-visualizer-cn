import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { TRANSPORT_KINDS } from '../../../shared/runtime/connectionProfile.js';

/**
 * Transport boundary. Declares each host transport's stable capability shape and which
 * management/execution roles it may carry. `live` records whether a transport is actually
 * wired to a real host in this build; ssh/slurm stay false until tasks 26-28 land, so a fixture
 * here never pretends to a live SSH/Slurm verification (task 46 owns that).
 */
export const TRANSPORT_CAPABILITIES = Object.freeze({
  local: Object.freeze({ management: true, execution: true, direct: true, ssh: false, slurm: false, managed: false, hostKey: false, live: true }),
  direct: Object.freeze({ management: true, execution: true, direct: true, ssh: false, slurm: false, managed: false, hostKey: false, live: true }),
  ssh: Object.freeze({ management: true, execution: true, direct: false, ssh: true, slurm: false, managed: true, hostKey: true, live: false }),
  slurm: Object.freeze({ management: true, execution: true, direct: false, ssh: false, slurm: true, managed: true, hostKey: false, live: false }),
});

export const TRANSPORT_ROLES = Object.freeze({
  local: Object.freeze(['local']),
  direct: Object.freeze(['local', 'manager', 'execution']),
  ssh: Object.freeze(['local', 'manager', 'execution']),
  slurm: Object.freeze(['manager', 'execution']),
});

function capabilitiesFor(kind) {
  requireValue(TRANSPORT_KINDS.includes(kind), 'transport.kind', 'unsupported');
  return TRANSPORT_CAPABILITIES[kind];
}

export function transportCapabilities(kind) {
  return capabilitiesFor(kind);
}

/** Projects a transport into the frozen `RuntimeInspection.transports` shape. */
export function transportInspection(kind) {
  const capabilities = capabilitiesFor(kind);
  return Object.freeze({ direct: capabilities.direct, ssh: capabilities.ssh, slurm: capabilities.slurm });
}

export function assertTransportSupportsRole(kind, role) {
  capabilitiesFor(kind);
  requireValue(TRANSPORT_ROLES[kind].includes(role), 'transport.role', 'unsupported');
  return role;
}

/** True for transports that require a management bridge in front of the target runtime. */
export function isManagedTransport(kind) {
  return capabilitiesFor(kind).managed;
}

/** True only when a real transport is wired in this build; ssh/slurm are not yet. */
export function transportLiveVerified(kind) {
  return capabilitiesFor(kind).live;
}

export function unsupportedTransport(kind) {
  return new ProtocolError('unsupported', `transport.${String(kind)}`);
}
