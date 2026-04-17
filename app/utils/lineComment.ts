export function formatCommentNote(
  path: string,
  startLine: number,
  endLine: number,
  text: string
): string {
  const normalized = path.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() || '';

  const lineLabel =
    startLine === endLine
      ? `line ${startLine}`
      : `lines ${startLine}-${endLine}`;

  return `The user made the following comment regarding ${lineLabel} of ${basename}: ${text}`;
}

export function buildLineCommentFileUrl(
  absolutePath: string,
  startLine: number,
  endLine: number
): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const withLeadingSlash = encoded.startsWith('/') ? encoded : `/${encoded}`;
  return `file://${withLeadingSlash}?start=${startLine}&end=${endLine}`;
}
