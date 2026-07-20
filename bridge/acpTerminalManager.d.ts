export type AcpTerminalCreateParams = {
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  cwd?: string;
  outputByteLimit?: number | null;
};

export type AcpTerminalManager = {
  create(params: AcpTerminalCreateParams): Promise<{ terminalId: string }>;
  output(terminalId: string): { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal: string | null } };
  waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }>;
  kill(terminalId: string): Promise<Record<string, never>>;
  release(terminalId: string): Promise<Record<string, never>>;
  stopAll(): Promise<void>;
};

export function createAcpTerminalManager(options?: object): AcpTerminalManager;
