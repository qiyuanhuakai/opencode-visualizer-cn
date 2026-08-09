import type { SpawnOptions } from 'node:child_process';

export type ProcessTreeChild = {
  readonly pid?: number;
  readonly exitCode?: number | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'exit' | 'close', listener: () => void): unknown;
  off(event: 'exit' | 'close', listener: () => void): unknown;
};

export type WindowsCommandChild = {
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
};

export function detachedProcessOptions(): { detached?: true };
export function signalProcessTree(child: ProcessTreeChild, signal: NodeJS.Signals): boolean;
export function forceStopProcessTree(pid: number): Promise<void>;
export function stopProcessTree(
  child: ProcessTreeChild,
  options?: { graceMs?: number; forceMs?: number },
): Promise<void>;
export function stopWindowsProcessTree(
  pid: number,
  force: boolean,
  options?: {
    spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => WindowsCommandChild;
  },
): Promise<void>;
