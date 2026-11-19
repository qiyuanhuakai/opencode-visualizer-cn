import type { Binding } from '../../shared/runtime/protocol.js';
import type { RuntimeParams, RuntimeResults, WireChunk } from '../../shared/runtime/runtimeWire.js';
import type { createWorkspaceService } from './workspaceService.js';
export type WorkspaceConnection = ReturnType<Awaited<ReturnType<typeof createWorkspaceService>>['connect']>;
export type ChannelContext = { readonly binding: Binding; readonly workspace: WorkspaceConnection; readonly current: () => void };
export interface RuntimeChannels {
  open(context: ChannelContext, input: RuntimeParams['runtime.channel.open']): Promise<RuntimeResults['runtime.channel.open']>;
  binary(bytes: Uint8Array): void;
  acknowledge(binding: Binding, chunk: WireChunk): Promise<WireChunk>;
  finish(binding: Binding, id: number): Promise<RuntimeResults['runtime.channel.finish']>;
  cancel(binding: Binding, id: number): Promise<{ readonly closed: true }>;
  readPty(context: ChannelContext, id: string): { readonly result: RuntimeResults['runtime.pty.read']; readonly binary: readonly Uint8Array[] };
  detachPty(context: ChannelContext, id: string): void;
  detach(target: string): void;
  close(): void;
  readonly size: number;
}
export function createRuntimeChannels(options: { readonly canSend: (bytes: number) => boolean }): RuntimeChannels;

