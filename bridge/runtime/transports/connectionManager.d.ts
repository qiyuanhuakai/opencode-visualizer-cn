import type { ConnectionProfile } from '../../../shared/runtime/connectionProfile.js';
import type { ConnectionProfileId, EnvironmentId } from '../../../shared/runtime/identity.js';
import type { ProfileStore } from './profileStore.js';

export type DialedTransport = {
  readonly environmentId: EnvironmentId | string;
  readonly connectionId?: string;
  readonly close?: () => unknown | Promise<unknown>;
};
export type OpenTransport = (profile: ConnectionProfile) => DialedTransport | Promise<DialedTransport>;
export type ConnectionState = 'disconnected' | 'connected' | 'failed';
export type ConnectionStatus = {
  readonly profileId: ConnectionProfileId;
  readonly state: ConnectionState;
  readonly environmentId: EnvironmentId | string;
  readonly generation: number;
};
export type DeleteReceipt = {
  readonly removed: ConnectionProfileId | undefined;
  readonly environmentId: EnvironmentId | string | undefined;
  readonly nativeHistoryPreserved: true;
  readonly ownedJobsPreserved: true;
  readonly cancelledJobs: 0;
  readonly preservedHandles: readonly string[];
};
export interface ConnectionManager {
  list(): Promise<readonly ConnectionProfile[]>;
  get(profileId: string): Promise<ConnectionProfile | undefined>;
  create(input: unknown): Promise<ConnectionProfile>;
  update(profileId: string, patch: unknown): Promise<ConnectionProfile | undefined>;
  setEnabled(profileId: string, enabled: boolean): Promise<ConnectionProfile | undefined>;
  status(profileId: string): Promise<ConnectionStatus | undefined>;
  inspect(): Promise<{ readonly profiles: readonly ConnectionStatus[] }>;
  connect(profileId: string): Promise<ConnectionStatus>;
  disconnect(profileId: string): Promise<ConnectionStatus>;
  reconnect(profileId: string): Promise<ConnectionStatus>;
  delete(profileId: string): Promise<DeleteReceipt>;
}
export function createConnectionManager(options: {
  readonly store: ProfileStore;
  readonly openTransport?: OpenTransport;
  readonly resources?: Readonly<Record<string, unknown>>;
}): ConnectionManager;
