import type { KimiWebSubagent } from '../../utils/kimiWeb';
import type { KimiWebHistoryEntry } from './historyEntries';
import { kimiWebSubagentSessionId } from './wire';

/** Attach unfinished children using exact parent tool identity, preserving REST history. */
export function restoreKimiWebSubagentLinks(
  entries: KimiWebHistoryEntry[],
  subagents: readonly KimiWebSubagent[],
): KimiWebHistoryEntry[] {
  for (const entry of entries) {
    for (const part of entry.parts) {
      if (part.type !== 'tool' || part.tool !== 'task') continue;
      const children = subagents.filter((child) => child.kind === 'subagent' && child.agent_id &&
        child.session_id === part.sessionID && child.parent_tool_call_id === part.callID);
      if (children.length === 0) continue;
      const existing = Array.isArray(part.metadata?.sessionIds) ? part.metadata.sessionIds : [];
      const labels = part.metadata?.subagentLabels;
      part.metadata = {
        ...part.metadata,
        sessionIds: [...new Set([...existing, ...children.map((child) =>
          kimiWebSubagentSessionId(child.session_id, child.agent_id ?? ''))])],
        subagentLabels: {
          ...(labels && typeof labels === 'object' && !Array.isArray(labels) ? labels : {}),
          ...Object.fromEntries(children.map((child) => {
            const id = kimiWebSubagentSessionId(child.session_id, child.agent_id ?? '');
            return [id, child.description || id];
          })),
        },
      };
    }
  }
  return entries;
}
