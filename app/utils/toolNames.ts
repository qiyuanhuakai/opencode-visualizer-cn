const WEBSEARCH_TOOL_ALIASES = new Set(['websearch', 'websearch_web_search_exa']);

const HISTORY_TOOL_NAMES = new Set([
  'bash',
  'write',
  'edit',
  'multiedit',
  'apply_patch',
  'websearch',
  'read',
  'grep',
  'glob',
  'webfetch',
  'codesearch',
]);

export function normalizeToolName(tool: string): string {
  return WEBSEARCH_TOOL_ALIASES.has(tool) ? 'websearch' : tool;
}

export function isHistoryToolName(tool: string): boolean {
  return HISTORY_TOOL_NAMES.has(normalizeToolName(tool));
}
