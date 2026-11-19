import type { StringDecoder } from 'node:string_decoder';

export type AcpStdoutEntry = {
  readonly agent: { readonly id: string };
  readonly status: { state: string; droppedFrames: number };
  stdoutBuffer: string;
  stdoutDecoder?: StringDecoder;
  stdoutQueue: Promise<void>;
  readonly pendingAgentResponses: Map<unknown, unknown>;
  readonly client?: { send(message: string): void };
  readonly clientGeneration: number;
  readonly child: { readonly stdin: { write(message: string): unknown } };
  discardingOversizedFrame?: boolean;
  runtimeOwned?: boolean;
  /** Raw stdout tap, installed only by the selected runtime-owned history producer. */
  rawTap?: (chunk: Uint8Array) => void;
};

export function createAcpStdoutForwarder(options: {
  readonly entries: Map<string, AcpStdoutEntry>;
  readonly handleClientRequest?: unknown;
}): (entry: AcpStdoutEntry, chunk: Buffer | string) => void;
