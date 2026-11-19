export const RELAY_HANDSHAKE_KIND: string;
export const RELAY_HELLO_ACK_KIND: string;
export const RELAY_HELLO_CONFIRM_KIND: string;
export const RELAY_HANDSHAKE_KINDS: readonly string[];
export const COMPUTE_OPERATION_KINDS: readonly string[];

export interface RelayBinding {
  readonly environmentId: string;
  readonly intentId: string;
  readonly bridgeInstanceId: string;
  readonly epoch: number;
  readonly computeNode: string;
  readonly stepId: string;
}

export function createRelayBinding(input: RelayBinding | Record<string, unknown>): RelayBinding;

export function compareRelayBindings(
  expected: RelayBinding,
  actual: unknown,
): { readonly match: boolean; readonly reason: 'binding' | 'epoch' | null };

export interface RelayHandshakeMessage {
  readonly kind: string;
  readonly nonce: string;
  readonly challenge?: string;
  readonly binding: RelayBinding;
  readonly token: string;
}

export interface RelayHandshake {
  readonly kind: string;
  readonly binding: RelayBinding;
  challenge(): RelayHandshakeMessage;
  ack(nonce: string): RelayHandshakeMessage;
  confirm(nonce: string, challenge: string): RelayHandshakeMessage;
  verify(message: unknown): boolean;
}

export function createRelayHandshake(options: { credential: string; binding: RelayBinding | Record<string, unknown> }): RelayHandshake;

export function assertRelayHello(options: { expected: RelayBinding | Record<string, unknown>; actual: unknown }): boolean;

export interface ComputeTarget {
  readonly kind: 'compute';
  readonly node: string;
  readonly environmentId?: unknown;
}

export function assertComputeTarget(options: {
  target: unknown;
  loginHosts?: readonly string[];
}): ComputeTarget;

export function routeComputeOperation(
  kind: string,
  options: { target: unknown; loginHosts?: readonly string[] },
): { readonly kind: string; readonly target: ComputeTarget; readonly host: string };
