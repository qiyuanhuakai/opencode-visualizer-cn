export type CodexTranscriptEntry = {
  id: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  time: number;
  modelName?: string;
};

type TranscriptItemType =
  | 'userMessage'
  | 'agentMessage'
  | 'plan'
  | 'commandExecution'
  | 'fileChange'
  | 'reasoning'
  | 'enteredReviewMode'
  | 'exitedReviewMode'
  | 'webSearch'
  | 'imageView'
  | 'mcpToolCall'
  | 'dynamicToolCall'
  | 'collabToolCall'
  | 'contextCompaction';

type TranscriptItem = {
  [Type in TranscriptItemType]: {
    readonly type: Type;
    readonly [key: string]: unknown;
  };
}[TranscriptItemType];

type TranscriptItemOf<Type extends TranscriptItemType> = Extract<
  TranscriptItem,
  { readonly type: Type }
>;

export type TranscriptEntryFactory = (
  role: CodexTranscriptEntry['role'],
  text: string,
) => CodexTranscriptEntry;

const TRANSCRIPT_ITEM_TYPES: ReadonlySet<string> = new Set([
  'userMessage',
  'agentMessage',
  'plan',
  'commandExecution',
  'fileChange',
  'reasoning',
  'enteredReviewMode',
  'exitedReviewMode',
  'webSearch',
  'imageView',
  'mcpToolCall',
  'dynamicToolCall',
  'collabToolCall',
  'contextCompaction',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractTextInput(value: unknown) {
  if (!isRecord(value)) return '';
  const text = value.text;
  return typeof text === 'string' ? text : '';
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function commandText(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string').join(' ');
  }
  return stringValue(value);
}

function jsonText(value: unknown) {
  return isRecord(value) ? JSON.stringify(value, null, 2) : '';
}

function prefixedText(prefix: string, value: unknown) {
  const text = stringValue(value);
  return text ? `${prefix}${text}` : '';
}

function isTranscriptItem(value: Record<string, unknown>): value is TranscriptItem {
  return typeof value.type === 'string' && TRANSCRIPT_ITEM_TYPES.has(value.type);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled transcript item: ${JSON.stringify(value)}`);
}

function mapUserMessage(
  item: TranscriptItemOf<'userMessage'>,
  createEntry: TranscriptEntryFactory,
) {
  const content = Array.isArray(item.content) ? item.content : [];
  const text = content.map(extractTextInput).filter(Boolean).join('\n');
  return text ? [createEntry('user', text)] : [];
}

function mapAgentMessage(
  item: TranscriptItemOf<'agentMessage'>,
  createEntry: TranscriptEntryFactory,
) {
  const text = stringValue(item.text);
  return text ? [createEntry('assistant', text)] : [];
}

function mapPlan(item: TranscriptItemOf<'plan'>, createEntry: TranscriptEntryFactory) {
  const text = stringValue(item.text);
  return text ? [createEntry('system', text)] : [];
}

function mapCommandExecution(
  item: TranscriptItemOf<'commandExecution'>,
  createEntry: TranscriptEntryFactory,
) {
  const command = commandText(item.command);
  const cwd = stringValue(item.cwd);
  const status = stringValue(item.status);
  const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
  const output = stringValue(item.aggregatedOutput);
  const text = [
    command ? `$ ${command}` : '',
    cwd ? `cwd: ${cwd}` : '',
    status ? `status: ${status}` : '',
    exitCode !== null ? `exit code: ${exitCode}` : '',
    output ? `\n${output}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return text ? [createEntry('system', text)] : [];
}

function mapFileChange(item: TranscriptItemOf<'fileChange'>, createEntry: TranscriptEntryFactory) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths = changes
    .filter((change): change is Record<string, unknown> => isRecord(change))
    .map((change) => (typeof change.path === 'string' ? change.path : ''))
    .filter(Boolean);
  const status = typeof item.status === 'string' ? item.status : '';
  const text = [
    paths.length > 0
      ? `File changes (${paths.length}):\n${paths.map((path) => `  ${path}`).join('\n')}`
      : 'File changes',
    status ? `status: ${status}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return text ? [createEntry('system', text)] : [];
}

function mapReasoning(item: TranscriptItemOf<'reasoning'>, createEntry: TranscriptEntryFactory) {
  const summary = stringValue(item.summary);
  const text = summary ? `Reasoning: ${summary}` : '';
  return text ? [createEntry('system', text)] : [];
}

function mapEnteredReviewMode(
  item: TranscriptItemOf<'enteredReviewMode'>,
  createEntry: TranscriptEntryFactory,
) {
  const review = typeof item.review === 'string' ? item.review : 'current changes';
  return [createEntry('system', `Entered review mode: ${review}`)];
}

function mapExitedReviewMode(
  item: TranscriptItemOf<'exitedReviewMode'>,
  createEntry: TranscriptEntryFactory,
) {
  const review = stringValue(item.review);
  return review ? [createEntry('system', `Review: ${review}`)] : [];
}

function mapWebSearch(item: TranscriptItemOf<'webSearch'>, createEntry: TranscriptEntryFactory) {
  const action = isRecord(item.action) ? item.action : null;
  const text = [
    prefixedText('Web search: ', item.query),
    prefixedText('action: ', action?.type),
    prefixedText('query: ', action?.query),
    prefixedText('url: ', action?.url),
  ]
    .filter(Boolean)
    .join('\n');
  return text ? [createEntry('system', text)] : [];
}

function mapImageView(item: TranscriptItemOf<'imageView'>, createEntry: TranscriptEntryFactory) {
  const path = typeof item.path === 'string' ? item.path : '';
  return path ? [createEntry('system', `Image: ${path}`)] : [];
}

function mapMcpToolCall(
  item: TranscriptItemOf<'mcpToolCall'>,
  createEntry: TranscriptEntryFactory,
) {
  const server = stringValue(item.server);
  const tool = stringValue(item.tool);
  const args = jsonText(item.arguments);
  const text = [
    server && tool ? `Tool call: ${server}.${tool}` : '',
    args ? `arguments:\n${args}` : '',
    prefixedText('status: ', item.status),
  ]
    .filter(Boolean)
    .join('\n');
  return text ? [createEntry('system', text)] : [];
}

function mapDynamicToolCall(
  item: TranscriptItemOf<'dynamicToolCall' | 'collabToolCall'>,
  createEntry: TranscriptEntryFactory,
) {
  const tool = stringValue(item.tool);
  const status = stringValue(item.status);
  const text = [tool ? `Tool call: ${tool}` : '', status ? `status: ${status}` : '']
    .filter(Boolean)
    .join('\n');
  return text ? [createEntry('system', text)] : [];
}

function mapContextCompaction(
  _item: TranscriptItemOf<'contextCompaction'>,
  createEntry: TranscriptEntryFactory,
) {
  return [createEntry('system', 'Context compaction completed')];
}

export function extractItemTranscriptEntries(item: unknown, createEntry: TranscriptEntryFactory) {
  if (!isRecord(item) || !isTranscriptItem(item)) return [];

  switch (item.type) {
    case 'userMessage':
      return mapUserMessage(item, createEntry);
    case 'agentMessage':
      return mapAgentMessage(item, createEntry);
    case 'plan':
      return mapPlan(item, createEntry);
    case 'commandExecution':
      return mapCommandExecution(item, createEntry);
    case 'fileChange':
      return mapFileChange(item, createEntry);
    case 'reasoning':
      return mapReasoning(item, createEntry);
    case 'enteredReviewMode':
      return mapEnteredReviewMode(item, createEntry);
    case 'exitedReviewMode':
      return mapExitedReviewMode(item, createEntry);
    case 'webSearch':
      return mapWebSearch(item, createEntry);
    case 'imageView':
      return mapImageView(item, createEntry);
    case 'mcpToolCall':
      return mapMcpToolCall(item, createEntry);
    case 'dynamicToolCall':
    case 'collabToolCall':
      return mapDynamicToolCall(item, createEntry);
    case 'contextCompaction':
      return mapContextCompaction(item, createEntry);
    default:
      return assertNever(item);
  }
}
