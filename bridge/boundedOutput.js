export function appendBoundedBuffer(current, chunk, limit) {
  const incoming = Buffer.from(chunk);
  if (incoming.length > limit - current.length) {
    return { buffer: current, overflow: true };
  }
  return { buffer: Buffer.concat([current, incoming]), overflow: false };
}
