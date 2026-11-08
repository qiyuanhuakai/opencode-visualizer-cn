import type { NativeTransport } from '../../../shared/runtime/native/codex/appServerClient.js';
export interface CodexProcess extends NativeTransport {
  readonly pid: number | undefined;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: string | null;
    readonly pid: number | undefined;
  }>;
  close(): Promise<void>;
  inspection(): {
    readonly pid: number | undefined;
    readonly closed: boolean;
    readonly stderrBytes: number;
    readonly maxFrameBytes: number;
    readonly failed: boolean;
  };
}
export function createCodexProcess(options?: {
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxFrameBytes?: number;
}): CodexProcess;
