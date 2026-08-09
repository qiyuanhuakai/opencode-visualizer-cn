export type PtySocket = {
  readonly destroyed: boolean;
  write(data: Buffer): boolean;
  end(data?: Buffer): unknown;
  destroy(error?: Error): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  once(event: 'close' | 'error', listener: () => void): unknown;
  emit(event: 'data', chunk: Buffer): boolean;
};

export type PtyManager = {
  create(payload?: unknown): Promise<{ readonly id: string }>;
  list(): readonly unknown[];
  resize(id: string, rows: unknown, cols: unknown): boolean;
  remove(id: string): boolean;
  disposeAll(): void;
  attach(id: string, socket: PtySocket, head: Buffer): boolean;
};

export function packagedNodePtyEntries(execPath: string, platform: NodeJS.Platform): string[];

export function createPtyManager(options?: {
  readonly ptyModule?: {
    spawn(command: string, args: readonly string[], options: object): unknown;
  };
}): PtyManager;
