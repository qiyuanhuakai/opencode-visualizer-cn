export type BoundedBufferResult = {
  buffer: Buffer;
  overflow: boolean;
};

export function appendBoundedBuffer(
  current: Buffer,
  chunk: string | Uint8Array,
  limit: number,
): BoundedBufferResult;
