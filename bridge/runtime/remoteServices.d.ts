import type { JsonValue } from '../../shared/runtime/capabilities.js';
import type { Frame, Hello, Request } from '../../shared/runtime/protocol.js';
import type { RuntimeInspection, TargetGrant } from '../../shared/runtime/runtimeWire.js';
import type { ConnectionProfile } from '../../shared/runtime/connectionProfile.js';
import type { ConnectionManager, DialedTransport } from './transports/connectionManager.js';
import type { ProfileStore } from './transports/profileStore.js';
import type { SshTransportOptions, SshResponder } from './transports/sshTransport.js';

export type RemoteMessage = Frame | { readonly kind: 'closed' } | { readonly kind: 'binary'; readonly data: Uint8Array };
export interface RemoteTarget {
  readonly hello: Hello;
  readonly grant: TargetGrant;
  readonly inspection: RuntimeInspection;
  request(frame: Pick<Request, 'method' | 'params'> & Partial<Pick<Request, 'idempotencyKey'>>, accepted?: (receipt: { readonly operationId: string }) => void): Promise<JsonValue>;
  subscribe(listener: (message: RemoteMessage) => void): () => void;
  sendBinary(data: Uint8Array): void;
  close(): void;
}
export interface RemoteServices {
  readonly capabilities: { readonly direct: boolean; readonly ssh: boolean; readonly slurm: boolean };
  openProfileTransport(profile: ConnectionProfile): Promise<DialedTransport>;
  configureProfiles(store: ProfileStore): ConnectionManager;
  getTarget(target: string): RemoteTarget | undefined;
  listTargets(): readonly TargetGrant[];
  refreshTargets(): Promise<void>;
  read(operation: string, args: Readonly<Record<string, JsonValue>>): Promise<unknown>;
  mutate(operation: string, args: Readonly<Record<string, JsonValue>>): Promise<unknown>;
  close(): Promise<void>;
}
export type RemoteChallenge = Parameters<SshResponder>[0] & { readonly profileId: string; readonly environmentId: string };
export interface RemoteServicesOptions {
  readonly stateRoot?: string;
  readonly configPath?: string;
  readonly loginHosts?: readonly string[];
  readonly profileStore?: ProfileStore;
  readonly ssh?: SshTransportOptions;
  readonly resolveCredential?: (reference: string) => Promise<{ readonly bridgeToken?: string; readonly ssh?: SshTransportOptions }>;
  readonly respondChallenge?: (challenge: RemoteChallenge) => ReturnType<SshResponder>;
  readonly onError?: (error: unknown) => void;
}
export function createRemoteServices(options?: RemoteServicesOptions): RemoteServices;
