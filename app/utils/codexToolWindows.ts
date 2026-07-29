import type { ToolPart } from '../types/sse';
import { normalizeToolName } from './toolNames';

export function shouldSkipAutoOpenWebTool(toolPart: ToolPart, isHistoryOpen = false) {
  if (isHistoryOpen) return false;
  const tool = normalizeToolName(toolPart.tool);
  if (tool !== 'websearch' && tool !== 'webfetch') return false;
  const query =
    typeof toolPart.state.input?.query === 'string' ? toolPart.state.input.query.trim() : '';
  const url = typeof toolPart.state.input?.url === 'string' ? toolPart.state.input.url.trim() : '';
  const runningOutput =
    toolPart.state.status === 'running' && typeof toolPart.state.metadata?.output === 'string'
      ? toolPart.state.metadata.output.trim()
      : '';
  const content =
    toolPart.state.status === 'completed'
      ? toolPart.state.output.trim()
      : toolPart.state.status === 'error'
        ? toolPart.state.error.trim()
        : runningOutput;
  return !query && !url && !content;
}
