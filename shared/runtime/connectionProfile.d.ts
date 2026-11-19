import type { ConnectionProfileId, EnvironmentId } from './identity.js';

export type TransportKind = 'local' | 'direct' | 'ssh' | 'slurm';
export type ConnectionRole = 'local' | 'manager' | 'execution';
export type ConnectionTransport = { readonly kind: TransportKind; readonly endpoint?: string };
export type ConnectionTarget =
  | { readonly kind: 'local' | 'direct' | 'ssh'; readonly environmentId: EnvironmentId }
  | { readonly kind: 'slurm'; readonly clusterEnvironmentId: EnvironmentId };
export type ConnectionProfile = {
  readonly profileId: ConnectionProfileId;
  readonly name: string;
  readonly transport: ConnectionTransport;
  readonly target: ConnectionTarget;
  readonly role: ConnectionRole;
  readonly credentialRef: string;
  readonly enabled: boolean;
};
export type ConnectionProfileDraft = Omit<ConnectionProfile, 'profileId'>;
export type ConnectionProfileDocument = { readonly version: 1; readonly profiles: readonly ConnectionProfile[] };

export const TRANSPORT_KINDS: readonly TransportKind[];
export const CONNECTION_ROLES: readonly ConnectionRole[];
export const TRANSPORT_TARGET_KIND: Readonly<Record<TransportKind, TransportKind>>;

export function assertNoSecretPayload(value: unknown, path?: string, depth?: number): unknown;
export function parseTransport(input: unknown): ConnectionTransport;
export function parseConnectionTarget(input: unknown): ConnectionTarget;
export function parseCredentialRef(input: unknown): string;
export function parseConnectionRole(input: unknown): ConnectionRole;
/** Strict persisted profile; rejects hidden/secret fields and validates the target mapping. */
export function parseConnectionProfile(input: unknown): ConnectionProfile;
/** Creation input; stable UUID assigned by the store, `enabled` defaults to false. */
export function parseNewConnectionProfile(input: unknown): ConnectionProfileDraft;
export function publicConnectionProfile(profile: ConnectionProfile): ConnectionProfile;
export function resolveProfileEnvironment(profile: { readonly target: ConnectionTarget }): EnvironmentId;
export function updateConnectionProfile(current: ConnectionProfile, patch: unknown): ConnectionProfile;
export function createProfileDocument(profiles: readonly ConnectionProfile[]): ConnectionProfileDocument;
export function parseProfileDocument(input: unknown): readonly ConnectionProfile[];
