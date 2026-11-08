import type { PathPolicy } from '../../shared/runtime/identity.js';
type Grant = { readonly root: string; readonly permissions: readonly ('read' | 'write' | 'command' | 'pty' | 'reverse')[]; readonly pathPolicy?: PathPolicy };
type Context = { readonly target: string; readonly epoch: string; readonly generation: number; readonly subscriberId: string; readonly assertCurrent: () => void };
type FileRequest = { readonly workspaceKey: string; readonly path: string };
type Chunk = { readonly channelId: number; readonly offset: number; readonly length: number };
type Output = { readonly output: string; readonly truncated: boolean; readonly exitStatus?: { readonly exitCode: number | null; readonly signal: string | null } };
type Command = { readonly workspaceKey: string; readonly command: string; readonly args?: readonly string[]; readonly cwd?: string };
export function createWorkspaceService(options: { readonly target: string; readonly epoch: string; readonly roots: readonly Grant[] }): Promise<{
  readonly workspaces: readonly { readonly key: string; readonly root: string; readonly pathPolicy: PathPolicy }[];
  connect(context: Context): {
    list(request: FileRequest): Promise<readonly { readonly name: string; readonly path: string; readonly type: string }[]>;
    read(request: FileRequest): Promise<{ readonly content: string; readonly dataBase64: string; readonly path: string }>;
    write(request: FileRequest & { readonly content: string }): Promise<{ readonly path: string }>;
    readonly files: {
      open(request: FileRequest & { readonly size: number; readonly sha256: string }): Promise<{ readonly channelId: number; readonly credits: number; readonly chunkBytes: number }>;
      append(request: { readonly channelId: number; readonly offset: number; readonly data: Uint8Array }): Promise<Chunk>;
      acknowledge(chunk: Chunk): void;
      finish(channelId: number): Promise<{ readonly path: string; readonly sha256: string; readonly size: number }>;
      cancel(channelId: number): Promise<void>;
    };
    readonly operations: {
      start(request: Command): Promise<{ readonly operationId: string }>;
      output(id: string): Output;
      wait(id: string): Promise<NonNullable<Output['exitStatus']>>;
      cancel(id: string): Promise<object>;
      remove(id: string): Promise<void>;
    };
    readonly ptys: {
      create(request: Command): Promise<{ readonly ptyId: string; readonly pid: number }>;
      subscribe(id: string): { readonly offset: number; readonly credits: number };
      read(id: string): { readonly chunks: readonly { readonly data: Uint8Array; readonly offset: number; readonly length: number }[]; readonly exited: boolean; readonly exitCode: number | null; readonly bufferedBytes: number };
      acknowledge(id: string, chunk: { readonly offset: number; readonly length: number }): void;
      write(id: string, data: string): void;
      resize(id: string, size: { readonly cols: number; readonly rows: number }): void;
      detach(id: string): void;
      remove(id: string): Promise<void>;
    };
    readonly reverse: { register(options: { readonly workspaceKey: string; readonly harnessInstanceId: string; readonly processGeneration: number; readonly agentId: string; readonly assertProcessCurrent: () => void; readonly homeDir?: string }): {
      observeClientMessage(message: { readonly id?: string | number; readonly method: string; readonly params: { readonly cwd: string; readonly sessionId?: string; readonly additionalDirectories?: readonly string[] } }): void;
      observeAgentMessage(message: { readonly id: string | number; readonly result: { readonly sessionId: string } }): void;
      handle(request: { readonly method: string; readonly params: Readonly<Record<string, unknown>> }): Promise<unknown>;
      close(): Promise<void>;
    } };
    disconnect(): Promise<void>;
  };
  close(): Promise<void>;
}>;
