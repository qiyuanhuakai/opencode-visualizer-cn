export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export function toAcpPromptBlocks(
  parts: Array<Record<string, unknown>>,
  supportsImages: boolean,
): AcpContentBlock[] {
  return parts.flatMap((part): AcpContentBlock[] => {
    if (part.type === 'text' && typeof part.text === 'string') {
      return [{ type: 'text', text: part.text }];
    }
    if (
      !supportsImages ||
      part.type !== 'file' ||
      typeof part.mime !== 'string' ||
      typeof part.url !== 'string' ||
      !part.mime.startsWith('image/')
    )
      return [];
    const marker = ';base64,';
    const offset = part.url.indexOf(marker);
    if (offset < 0) return [];
    return [{ type: 'image', mimeType: part.mime, data: part.url.slice(offset + marker.length) }];
  });
}
