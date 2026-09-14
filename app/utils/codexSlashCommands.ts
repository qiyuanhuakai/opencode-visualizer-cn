const definitions = [
  ['model', 'Choose model and reasoning effort', '选择模型与推理强度'],
  ['fast', 'Toggle Fast service tier', '切换 Fast 服务档位'],
  ['permissions', 'Choose permission mode', '选择权限模式'],
  ['status', 'Open status monitor', '打开状态监控'],
  ['usage', 'Show token usage', '查看 Token 使用量'],
  ['init', 'Create repository AGENTS.md', '创建仓库 AGENTS.md'],
  ['plan', 'Toggle plan mode', '切换规划模式'],
  ['goal', 'Manage the current goal', '管理当前目标'],
  ['compact', 'Compact context', '压缩上下文'],
  ['new', 'Start a new conversation', '开始新会话'],
  ['resume', 'Resume a conversation', '恢复会话'],
  ['fork', 'Fork the conversation', '分叉会话'],
  ['btw', 'Ask in a temporary side conversation', '在临时侧聊中提问'],
  ['side', 'Open a temporary side conversation', '打开临时侧聊'],
  ['rename', 'Rename the conversation', '重命名会话'],
  ['archive', 'Archive the conversation', '归档会话'],
  ['diff', 'Show repository changes', '查看仓库改动'],
  ['review', 'Review repository changes', '审查仓库改动'],
  ['skills', 'Open status monitor', '打开状态监控'],
  ['mcp', 'Open status monitor', '打开状态监控'],
  ['plugins', 'Open status monitor', '打开状态监控'],
  ['ps', 'Show background processes', '查看后台进程'],
  ['stop', 'Stop background terminals', '停止后台终端'],
  ['copy', 'Copy the latest response', '复制最新回复'],
] as const;

export type CodexSlashCommandName = (typeof definitions)[number][0];
export type ParsedCodexSlashCommand = {
  readonly name: CodexSlashCommandName;
  readonly arguments: string;
};

export function listCodexSlashCommands(locale = 'en') {
  return definitions.map(([name, en, zh]) => ({
    name,
    description: locale.toLowerCase().startsWith('zh') ? zh : en,
  }));
}

export function parseLeadingSlashCommand(input: string) {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  if (!match?.[1]) return null;
  return { name: match[1].toLowerCase(), arguments: (match[2] ?? '').trim() };
}

export function parseCodexSlashCommand(input: string): ParsedCodexSlashCommand | null {
  const parsed = parseLeadingSlashCommand(input);
  const definition = definitions.find(([name]) => name === parsed?.name);
  return parsed && definition ? { name: definition[0], arguments: parsed.arguments } : null;
}
