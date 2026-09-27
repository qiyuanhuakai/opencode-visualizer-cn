import type { SpawnOptions } from 'node:child_process';

export function parseWslDistros(output: Buffer | string): string[];
export function findLocalWslBridge(
  version: string | null,
  runCommand?: (command: string, args: string[], options: object) => Promise<{ stdout: Buffer | string }>,
  signal?: AbortSignal,
): Promise<string | null>;
export function openWslBridgeTerminal(
  distro: string,
  launch?: (command: string, args: string[], options: SpawnOptions) => {
    once(event: string, listener: (...args: unknown[]) => void): unknown;
    unref(): void;
  },
): Promise<void>;
