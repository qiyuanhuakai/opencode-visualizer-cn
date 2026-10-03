export function decodeDshFileContent(bytes: Uint8Array) {
  if (!bytes.includes(0)) {
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { type: 'text' as const, encoding: 'utf-8' as const, content };
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return { type: 'binary' as const, encoding: 'base64' as const, content: btoa(chunks.join('')) };
}
