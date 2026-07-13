import { computed, readonly, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue';

export type ForgeConversation = {
  readonly id: string;
  readonly title: string;
  readonly updated: string;
};

export type ForgeInfo = {
  readonly model: string;
  readonly providerUrl: string;
  readonly conversationId: string;
};

export type ForgeAuxiliaryCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<string>;

export type ForgeAuxiliaryState = {
  readonly conversations: Readonly<ShallowRef<readonly ForgeConversation[]>>;
  readonly info: Readonly<ShallowRef<ForgeInfo | null>>;
  readonly selectedConversationId: Readonly<Ref<string>>;
  readonly selectedMarkdown: Readonly<Ref<string>>;
  readonly selectedDump: Readonly<Ref<string>>;
  readonly loading: Readonly<Ref<boolean>>;
  readonly error: Readonly<Ref<string>>;
  readonly statusLabel: ComputedRef<string>;
  readonly refreshAll: () => Promise<void>;
  readonly refreshInfo: () => Promise<void>;
  readonly selectConversation: (id: string) => Promise<void>;
  readonly dumpConversation: (id: string) => Promise<void>;
};

const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const FORGE_DUMP_SCRIPT = [
  'set -euo pipefail',
  'tmpdir="$(mktemp -d)"',
  'log_file="$tmpdir/dump.log"',
  'trap \'rm -rf "$tmpdir"\' EXIT',
  'cd "$tmpdir"',
  'forge conversation dump "$1" >"$log_file" 2>&1',
  'dump_file=""',
  'for candidate in ./*-dump.json; do',
  '  if [ -f "$candidate" ]; then dump_file="$candidate"; break; fi',
  'done',
  'if [ -z "$dump_file" ]; then cat "$log_file" >&2; exit 1; fi',
  'cat "$dump_file"',
].join('\n');

function cleanForgeLines(output: string) {
  return output
    .replace(ANSI_ESCAPE_SEQUENCE, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function isForgeConversation(value: ForgeConversation | null): value is ForgeConversation {
  return value !== null;
}

function isPresentText(value: string) {
  return value.length > 0;
}

function normalizeForgeEmpty(value: string) {
  return value === '[empty]' ? '' : value;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function parseForgeConversationList(output: string): readonly ForgeConversation[] {
  const lines = cleanForgeLines(output);
  const headerIndex = lines.findIndex(
    (line) => line.includes('ID') && line.includes('TITLE') && line.includes('UPDATED'),
  );
  const header = headerIndex >= 0 ? lines[headerIndex] ?? '' : '';
  const titleStart = header.indexOf('TITLE');
  const updatedStart = header.indexOf('UPDATED');
  if (titleStart < 0 || updatedStart <= titleStart) return [];

  return lines
    .slice(headerIndex + 1)
    .map((line) => {
      const id = line.slice(0, titleStart).trim();
      if (!id) return null;
      const title = line.slice(titleStart, updatedStart).trim() || '[empty]';
      const updated = line.slice(updatedStart).trim();
      return { id, title, updated };
    })
    .filter(isForgeConversation);
}

export function parseForgeInfo(output: string): ForgeInfo {
  let model = '';
  let providerUrl = '';
  let conversationId = '';

  for (const line of cleanForgeLines(output)) {
    const match = /^(AGENT|CONVERSATION)\s+(.+?)\s{2,}(.+)$/.exec(line);
    const section = match?.[1] ?? '';
    const key = match?.[2]?.trim() ?? '';
    const value = match?.[3]?.trim() ?? '';
    if (section === 'AGENT' && key === 'model') model = value;
    if (section === 'AGENT' && key === 'provider (url)') providerUrl = value;
    if (section === 'CONVERSATION' && key === 'id') conversationId = normalizeForgeEmpty(value);
  }

  return { model, providerUrl, conversationId };
}

export function useForgeAuxiliary(runCommand: ForgeAuxiliaryCommandRunner): ForgeAuxiliaryState {
  const conversations = shallowRef<readonly ForgeConversation[]>([]);
  const info = shallowRef<ForgeInfo | null>(null);
  const selectedConversationId = ref('');
  const selectedMarkdown = ref('');
  const selectedDump = ref('');
  const loading = ref(false);
  const error = ref('');

  const statusLabel = computed(() => {
    const current = info.value;
    if (!current) return '';
    return [current.model, current.providerUrl, current.conversationId].filter(isPresentText).join(' · ');
  });

  async function runAuxiliaryOperation(operation: () => Promise<void>) {
    loading.value = true;
    error.value = '';
    try {
      await operation();
    } catch (caught) {
      error.value = toErrorMessage(caught);
    } finally {
      loading.value = false;
    }
  }

  async function refreshInfo() {
    await runAuxiliaryOperation(async () => {
      info.value = parseForgeInfo(await runCommand('forge', ['info', '--porcelain']));
    });
  }

  async function loadConversationMarkdown(id: string) {
    selectedConversationId.value = id;
    selectedDump.value = '';
    selectedMarkdown.value = await runCommand('forge', ['conversation', 'show', id, '--md']);
  }

  async function selectConversation(id: string) {
    await runAuxiliaryOperation(async () => {
      await loadConversationMarkdown(id);
    });
  }

  async function refreshAll() {
    await runAuxiliaryOperation(async () => {
      const [conversationOutput, infoOutput] = await Promise.all([
        runCommand('forge', ['list', 'conversation', '--porcelain']),
        runCommand('forge', ['info', '--porcelain']),
      ]);
      const nextConversations = parseForgeConversationList(conversationOutput);
      conversations.value = nextConversations;
      info.value = parseForgeInfo(infoOutput);
      const currentId = selectedConversationId.value;
      const selectedId = nextConversations.some((conversation) => conversation.id === currentId)
        ? currentId
        : nextConversations[0]?.id ?? '';
      if (selectedId) {
        await loadConversationMarkdown(selectedId);
        return;
      }
      selectedConversationId.value = '';
      selectedMarkdown.value = '';
      selectedDump.value = '';
    });
  }

  async function dumpConversation(id: string) {
    await runAuxiliaryOperation(async () => {
      selectedConversationId.value = id;
      selectedDump.value = await runCommand('bash', ['--noprofile', '--norc', '-c', FORGE_DUMP_SCRIPT, '_', id]);
    });
  }

  return {
    conversations: readonly(conversations),
    info: readonly(info),
    selectedConversationId: readonly(selectedConversationId),
    selectedMarkdown: readonly(selectedMarkdown),
    selectedDump: readonly(selectedDump),
    loading: readonly(loading),
    error: readonly(error),
    statusLabel,
    refreshAll,
    refreshInfo,
    selectConversation,
    dumpConversation,
  };
}
