import type { KimiWebContentPart, KimiWebMessage } from '../../utils/kimiWeb';
import type { KimiWebClient } from '../../utils/kimiWeb';
import { collectKimiWebHistoryMessages } from './history';

function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2) ?? '';
}

function formatPart(part: KimiWebContentPart, toolNames: Map<string, string>): string {
  switch (part.type) {
    case 'text': return part.text;
    case 'thinking': return part.thinking.trim() ? `<details><summary>Thinking</summary>\n\n${part.thinking}\n\n</details>` : '';
    case 'tool_use': {
      toolNames.set(part.tool_call_id, part.tool_name);
      return `#### Tool Call: ${part.tool_name}\n\n\`\`\`json\n${printable(part.input)}\n\`\`\``;
    }
    case 'tool_result': return `<details><summary>Tool Result: ${toolNames.get(part.tool_call_id) ?? part.tool_call_id}${part.is_error ? ' (error)' : ''}</summary>\n\n${printable(part.output)}\n\n</details>`;
    case 'image': return `[Image${part.name ? `: ${part.name}` : ''}]`;
    case 'video': return `[Video${part.name ? `: ${part.name}` : ''}]`;
    case 'file': return `[File: ${part.name ?? part.path ?? part.file_id ?? 'attachment'}]`;
  }
}

export function formatKimiWebSessionMarkdown(messages: readonly KimiWebMessage[]): string {
  const blocks: string[] = ['# Session transcript'];
  const toolNames = new Map<string, string>();
  let turn = 0;
  let assistantHeading = false;
  for (const message of messages) {
    const body = message.content.map((part) => formatPart(part, toolNames)).filter(Boolean).join('\n\n');
    if (!body) continue;
    if (message.role === 'user' || turn === 0) {
      turn += 1;
      assistantHeading = false;
      blocks.push(`## Turn ${turn}`);
    }
    if (message.role === 'user') blocks.push('### User');
    else if (message.role === 'assistant' && !assistantHeading) {
      blocks.push('### Assistant');
      assistantHeading = true;
    } else if (message.role === 'system') blocks.push('### System');
    blocks.push(body);
  }
  return `${blocks.join('\n\n')}\n`;
}

export async function copyKimiWebSessionMarkdown(
  sessionId: string,
  getMessages: KimiWebClient['getMessages'],
  writeText: (text: string) => Promise<void>,
): Promise<void> {
  const history = await collectKimiWebHistoryMessages({ sessionId, fetchPage: getMessages });
  if (history.truncated) throw new Error('The full session could not be loaded for copying.');
  await writeText(formatKimiWebSessionMarkdown(history.messages));
}
