export type NativeServiceDefinition = {
  id: 'opencode' | 'codex';
  name: string;
  command: string;
  args: string[];
  probe: { type: 'http'; url: string } | { type: 'tcp'; host: string; port: number };
};

export type ProcessStatus = {
  id: string;
  name: string;
  kind: 'native';
  command: string;
  args: string[];
  state: 'stopped' | 'starting' | 'running' | 'adopted' | 'stopping' | 'error';
  owned: boolean;
  pid?: number;
  error?: string;
};

export type ProcessSupervisor = {
  start(): Promise<ProcessStatus[]>;
  stop(): Promise<void>;
  getStatus(): ProcessStatus[];
};

export type SpawnedProcessLike = {
  pid?: number;
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
};

export function createNativeServiceDefinitions(): NativeServiceDefinition[];
export function probeNativeService(service: NativeServiceDefinition): Promise<boolean>;
export function createProcessSupervisor(options?: {
  services?: NativeServiceDefinition[];
  spawnProcess?: (command: string, args: readonly string[], options: object) => SpawnedProcessLike;
  probeService?: (service: NativeServiceDefinition) => Promise<boolean>;
  readinessAttempts?: number;
  readinessIntervalMs?: number;
}): ProcessSupervisor;
