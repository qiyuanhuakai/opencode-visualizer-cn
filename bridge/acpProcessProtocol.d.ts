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
};

export function createAcpStdoutForwarder(options: {
  readonly entries: Map<string, AcpStdoutEntry>;
  readonly handleClientRequest?: unknown;
}): (entry: AcpStdoutEntry, chunk: Buffer | string) => void;
