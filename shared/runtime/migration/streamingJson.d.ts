export class LegacyExportError extends Error { readonly code: string; constructor(code: string); }
export type StringChunk = Readonly<{ content: string; end: boolean }>;
export function stringChunks(text: string): Generator<StringChunk>;
export function streamStringMap(input: AsyncIterable<string>): AsyncGenerator<StringChunk & Readonly<{ key: string }>>;
