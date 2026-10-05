import type { Capabilities } from './capabilities.js';
import type { Binding, Chunk, Frame, Request, Snapshot } from './protocol.js';
export type ExtensionGrant = { readonly capabilities: Capabilities; readonly permissions: readonly string[] };
export type ProtocolStateSnapshot = Binding & {
  readonly revision: number; readonly fences: readonly (readonly [string, number])[]; readonly seq: number; readonly pending: number; readonly usedIds: number; readonly channels: number; readonly closed: boolean;
  readonly inflight: readonly { readonly channelId: number; readonly nextOffset: number; readonly chunks: readonly (readonly [number, number])[] }[];
};
export type ProtocolState = {
  readonly register: (input: unknown, extensionGrant?: ExtensionGrant) => Request;
  readonly acceptSnapshot: (input: unknown, now: number) => Snapshot;
  readonly receive: (input: unknown) => Frame;
  readonly openChannel: (channelId: number) => void;
  readonly reserveChunk: (input: Chunk) => Chunk;
  readonly acknowledgeChunk: (input: Chunk) => void;
  readonly closeChannel: (channelId: number) => void;
  readonly snapshot: () => ProtocolStateSnapshot;
  readonly close: () => void;
};
/** One state per target/epoch/generation; close and recreate on reconnect.
 * Channels are connection-local and must be associated with authenticated routing by callers.
 * Channel IDs cannot be reused, preventing late acknowledgements from crediting new streams.
 * Request IDs cannot be reused in a connection; reconnect after 65536 registrations.
 * Accepted is a protocol phase, not proof of durable storage. The store owner supplies that proof.
 */
export function createProtocolState(input: Binding): ProtocolState;
