export type AcpStdoutEntry = {
  readonly agent: { readonly id: string };
  readonly status: { state: string; droppedFrames: number };
  stdoutBuffer: string;
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
}): (entry: AcpStdoutEntry, chunk: unknown) => void;
