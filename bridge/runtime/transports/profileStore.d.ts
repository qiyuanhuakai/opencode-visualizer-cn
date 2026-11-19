import type { ConnectionProfile, ConnectionProfileDraft } from '../../../shared/runtime/connectionProfile.js';

export interface ProfileStore {
  readonly profilePath: string;
  load(): Promise<readonly ConnectionProfile[]>;
  list(): Promise<readonly ConnectionProfile[]>;
  get(profileId: string): Promise<ConnectionProfile | undefined>;
  create(input: ConnectionProfileDraft | unknown): Promise<ConnectionProfile>;
  update(profileId: string, patch: unknown): Promise<ConnectionProfile | undefined>;
  setEnabled(profileId: string, enabled: boolean): Promise<ConnectionProfile | undefined>;
  remove(profileId: string): Promise<ConnectionProfile | undefined>;
}
export function createProfileStore(options: { readonly profilePath: string }): ProfileStore;
