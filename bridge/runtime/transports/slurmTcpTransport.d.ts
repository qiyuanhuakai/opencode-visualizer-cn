import type { RelayBinding } from './relayHandshake.js';
import type { RelayChannel } from './computeRelay.js';

export interface SlurmForward {
  readonly localHost?: string;
  readonly localPort?: number;
  readonly remoteHost: string;
  readonly remotePort: number;
}

export interface SlurmTcpConnection {
  readonly connectionId: string;
  readonly ready: boolean;
  readonly state: string;
  readonly target: { readonly kind: 'compute'; readonly node: string; readonly environmentId?: unknown };
  readonly binding: RelayBinding;
  readonly channel: RelayChannel;
  readonly forwardArgv: readonly string[];
  close(): Promise<void>;
}

export interface SlurmTcpTransport {
  program(): string;
  forwardArgv(forward: SlurmForward): readonly string[];
  environment(channel?: unknown): Record<string, string>;
  open(input: { forward: SlurmForward; binding?: RelayBinding | Record<string, unknown> }): Promise<SlurmTcpConnection>;
  state(connectionId: string): string;
}

export function createSlurmTcpTransport(options?: {
  connect?: (options: { host: string; port: number }) => unknown;
  binding?: RelayBinding | Record<string, unknown>;
  credential?: string;
  loginHosts?: readonly string[];
  platform?: string;
  target?: unknown;
  configPath?: string;
  knownHostsFile?: string;
  baseEnv?: Record<string, string | undefined>;
  store?: unknown;
  timeoutMs?: number;
}): SlurmTcpTransport;
