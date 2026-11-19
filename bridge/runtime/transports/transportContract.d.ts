import type { TransportKind, ConnectionRole } from '../../../shared/runtime/connectionProfile.js';
import type { ProtocolError } from '../../../shared/runtime/capabilities.js';

export type TransportCapabilities = {
  readonly management: boolean;
  readonly execution: boolean;
  readonly direct: boolean;
  readonly ssh: boolean;
  readonly slurm: boolean;
  readonly managed: boolean;
  readonly hostKey: boolean;
  readonly live: boolean;
};
export const TRANSPORT_CAPABILITIES: Readonly<Record<TransportKind, TransportCapabilities>>;
export const TRANSPORT_ROLES: Readonly<Record<TransportKind, readonly ConnectionRole[]>>;
export function transportCapabilities(kind: TransportKind): TransportCapabilities;
export function transportInspection(kind: TransportKind): { readonly direct: boolean; readonly ssh: boolean; readonly slurm: boolean };
export function assertTransportSupportsRole(kind: TransportKind, role: ConnectionRole): ConnectionRole;
export function isManagedTransport(kind: TransportKind): boolean;
export function transportLiveVerified(kind: TransportKind): boolean;
export function unsupportedTransport(kind: unknown): ProtocolError;
