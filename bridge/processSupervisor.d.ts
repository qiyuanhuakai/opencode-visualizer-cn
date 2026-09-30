export type NativeServiceDefinition = {
  id: 'opencode' | 'codex' | 'kimi-web' | 'dsh';
  name: string;
  command: string;
  args: string[];
  probe:
    | { type: 'http'; url: string; expectJson?: Readonly<Record<string, unknown>> }
    | { type: 'tcp'; host: string; port: number };
};

export type ProcessStatus = {
  id: string;
  name: string;
  kind: 'native';
  command: string;
  args: string[];
  state: 'stopped' | 'disabled' | 'starting' | 'running' | 'adopted' | 'stopping' | 'error';
  owned: boolean;
  pid?: number;
  error?: string;
  /** Detected `dsh --version` value, recorded for display once known (dsh only). */
  version?: string;
};

export type ProcessSupervisor = {
  start(enabledServices?: {
    opencode: boolean;
    codex: boolean;
    'kimi-web': boolean;
    dsh?: boolean;
  }): Promise<ProcessStatus[]>;
  stop(): Promise<void>;
  getStatus(): ProcessStatus[];
  /** Cookie provider for the bridge dsh proxies; the launch token lives here. */
  getDshAuthProvider?(): {
    getCookie(authority: string): Promise<string>;
    invalidate(authority: string): boolean;
  };
};

export type SpawnedProcessLike = {
  pid?: number;
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  stdout?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal: NodeJS.Signals): boolean;
};

/** dsh port occupancy classification (spawn-only: `fence` and `mismatch` are errors). */
export type DshWebFenceState =
  | { readonly state: 'idle' }
  | { readonly state: 'fence' }
  | { readonly state: 'mismatch'; readonly reason: string };

export type DshWebAuthProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function createNativeServiceDefinitions(): NativeServiceDefinition[];
export function probeNativeService(service: NativeServiceDefinition): Promise<boolean>;
export function createProcessSupervisor(options?: {
  services?: NativeServiceDefinition[];
  spawnProcess?: (command: string, args: readonly string[], options: object) => SpawnedProcessLike;
  probeService?: (service: NativeServiceDefinition) => Promise<boolean>;
  probeKimiWebHealth?: (
    service: NativeServiceDefinition,
  ) => Promise<
    | { readonly state: 'idle' }
    | { readonly state: 'matching' }
    | { readonly state: 'mismatch'; readonly reason: string }
  >;
  probeKimiWebAuth?: (
    authorization: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  kimiWebTokenProvider?: { getAuthorization(): string };
  probeDshWebFence?: (service: NativeServiceDefinition) => Promise<DshWebFenceState>;
  probeDshWebAuth?: (cookie: string) => Promise<DshWebAuthProbeResult>;
  /** Injected into the default dsh cookie exchange for deterministic tests. */
  dshExchange?: (request: {
    readonly authority: string;
    readonly launchToken: string;
  }) => Promise<unknown>;
  dshVersionProbe?: () => Promise<string>;
  readinessAttempts?: number;
  readinessIntervalMs?: number;
}): ProcessSupervisor;
