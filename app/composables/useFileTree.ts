import { computed, ref, watch } from 'vue';
import type { Ref } from 'vue';
import * as opencodeApi from '../utils/opencode';

export type TreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: TreeNode[];
  loaded?: boolean;
  ignored?: boolean;
  synthetic?: boolean;
};

export type FileNode = {
  name?: string;
  path: string;
  type?: string;
  ignored?: boolean;
};

export type SessionDiffEntry = {
  file?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
  status?: 'added' | 'modified' | 'deleted';
};

type UseFileTreeOptions = {
  activeDirectory: Ref<string>;
  selectedSessionId: Ref<string>;
};

let boundOptions: UseFileTreeOptions | null = null;

const treeNodes = ref<TreeNode[]>([]);
const expandedTreePathSet = ref(new Set<string>());
const selectedTreePath = ref('');
const treeLoading = ref(false);
const treeError = ref('');
const sessionStatusByPath = ref<Record<string, 'added' | 'modified' | 'deleted'>>({});
const sessionDiffEntries = ref<SessionDiffEntry[]>([]);
const sessionDiffByPath = ref<Record<string, SessionDiffEntry>>({});
const files = ref<string[]>([]);
const fileCacheVersion = ref(0);

let sessionDiffRequestId = 0;
let fileCacheBuildId = 0;

function getOptions(): UseFileTreeOptions {
  if (!boundOptions) {
    throw new Error('useFileTree must be initialized with options before use');
  }
  return boundOptions;
}

function normalizeDirectory(value: string) {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed || value;
}

function normalizeRelativePath(path: string) {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '.') return '.';
  const withoutPrefix = trimmed
    .replace(/^\.\//, '')
    .replace(/^\//, '')
    .replace(/^(\.\.\/)+/, '');
  const normalized = withoutPrefix.replace(/\/+/g, '/').replace(/\/$/, '');
  return normalized || '.';
}

function toRelativePath(path: string, directory: string) {
  const normalizedDirectory = normalizeDirectory(directory);
  const normalizedPath = normalizeDirectory(path);
  if (normalizedPath === normalizedDirectory) return '.';
  const prefix = `${normalizedDirectory}/`;
  if (normalizedPath.startsWith(prefix))
    return normalizeRelativePath(normalizedPath.slice(prefix.length));
  return normalizeRelativePath(normalizedPath);
}

function normalizeFileNode(item: unknown, directory: string): FileNode | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const rawPath =
    (typeof record.path === 'string' && record.path) ||
    (typeof record.name === 'string' && record.name) ||
    undefined;
  if (!rawPath) return null;
  const path = toRelativePath(rawPath, directory);
  const name =
    (typeof record.name === 'string' && record.name) ||
    (path === '.' ? '.' : path.split('/').at(-1)) ||
    path;
  const rawType = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  const type = rawType.includes('dir') ? 'directory' : 'file';
  const ignored = Boolean(record.ignored);
  return { path, name, type, ignored };
}

function sortTreeNodes(nodes: TreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

function buildTreeNodes(items: unknown[], directory: string, parentPath: string) {
  const unique = new Map<string, TreeNode>();
  items.forEach((item) => {
    const node = normalizeFileNode(item, directory);
    if (!node) return;
    if (node.path === parentPath || node.path === '.') return;
    const relativeToParent =
      parentPath === '.'
        ? node.path
        : node.path.startsWith(`${parentPath}/`)
          ? node.path.slice(parentPath.length + 1)
          : node.path.includes('/')
            ? ''
            : node.path;
    if (!relativeToParent) return;
    const name = relativeToParent.split('/')[0];
    const path = parentPath === '.' ? name : `${parentPath}/${name}`;
    const isLeaf = !relativeToParent.includes('/');
    const existing = unique.get(path);
    if (existing) {
      if (existing.type === 'file' && !isLeaf) {
        existing.type = 'directory';
        existing.children = [];
      }
      if (node.ignored) existing.ignored = true;
      return;
    }
    const normalizedType: TreeNode['type'] = node.type === 'directory' ? 'directory' : 'file';
    unique.set(path, {
      name,
      path,
      type: isLeaf ? normalizedType : 'directory',
      children: isLeaf && normalizedType !== 'directory' ? undefined : [],
      loaded: false,
      ignored: Boolean(node.ignored),
      synthetic: false,
    });
  });
  return sortTreeNodes(Array.from(unique.values()));
}

function updateTreeNodeChildren(
  nodes: TreeNode[],
  targetPath: string,
  children: TreeNode[],
): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return {
        ...node,
        type: 'directory',
        children,
        loaded: true,
      };
    }
    if (node.children?.length) {
      return { ...node, children: updateTreeNodeChildren(node.children, targetPath, children) };
    }
    return node;
  });
}

function findTreeNodeByPath(nodes: TreeNode[], targetPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (!node.children?.length) continue;
    const child = findTreeNodeByPath(node.children, targetPath);
    if (child) return child;
  }
  return null;
}

function aggregateSessionStatuses() {
  const fileStatuses = sessionStatusByPath.value;
  const next: Record<string, 'added' | 'modified' | 'deleted'> = { ...fileStatuses };
  const priority = { added: 1, modified: 2, deleted: 3 } as const;
  Object.entries(fileStatuses).forEach(([path, status]) => {
    if (path === '.') return;
    const segments = path.split('/');
    while (segments.length > 1) {
      segments.pop();
      const parent = segments.join('/');
      const current = next[parent];
      if (!current || priority[status] > priority[current]) {
        next[parent] = status;
      }
    }
  });
  sessionStatusByPath.value = next;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeSessionDiffEntries(entries: unknown[]) {
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const file = typeof record.file === 'string' ? record.file : undefined;
      const status =
        typeof record.status === 'string'
          ? (record.status as 'added' | 'modified' | 'deleted')
          : undefined;
      const additions = typeof record.additions === 'number' ? record.additions : undefined;
      const deletions = typeof record.deletions === 'number' ? record.deletions : undefined;
      const before = typeof record.before === 'string' ? record.before : undefined;
      const after = typeof record.after === 'string' ? record.after : undefined;
      return { file, status, additions, deletions, before, after } as SessionDiffEntry;
    })
    .filter((entry): entry is SessionDiffEntry => Boolean(entry?.file));
}

function updateSessionDiffState(entries: SessionDiffEntry[]) {
  sessionDiffEntries.value = entries;
  const next: Record<string, 'added' | 'modified' | 'deleted'> = {};
  const nextByPath: Record<string, SessionDiffEntry> = {};
  const directory = getOptions().activeDirectory.value.trim();
  entries.forEach((entry) => {
    if (!entry.file) return;
    const relativePath = toRelativePath(entry.file, directory);
    if (relativePath === '.') return;
    if (entry.status) next[relativePath] = entry.status;
    nextByPath[relativePath] = entry;
  });
  sessionStatusByPath.value = next;
  sessionDiffByPath.value = nextByPath;
  aggregateSessionStatuses();
}

async function refreshSessionDiff() {
  const requestId = ++sessionDiffRequestId;
  const options = getOptions();
  const sessionId = options.selectedSessionId.value;
  if (!sessionId) {
    updateSessionDiffState([]);
    return;
  }
  const directory = options.activeDirectory.value.trim();
  try {
    const data = await opencodeApi.getSessionDiff({
      sessionID: sessionId,
      directory,
    });
    if (requestId !== sessionDiffRequestId) return;
    if (options.selectedSessionId.value !== sessionId) return;
    if (options.activeDirectory.value.trim() !== directory) return;
    const entries = Array.isArray(data) ? normalizeSessionDiffEntries(data) : [];
    updateSessionDiffState(entries);
  } catch {
    if (requestId !== sessionDiffRequestId) return;
    if (options.selectedSessionId.value !== sessionId) return;
    if (options.activeDirectory.value.trim() !== directory) return;
    updateSessionDiffState([]);
  }
}

function toggleTreeDirectory(path: string) {
  const next = new Set(expandedTreePathSet.value);
  if (next.has(path)) {
    next.delete(path);
    expandedTreePathSet.value = next;
    return;
  } else {
    next.add(path);
  }
  expandedTreePathSet.value = next;
  const node = findTreeNodeByPath(treeNodes.value, path);
  if (node?.loaded) return;
  void loadSingleDirectory(path);
}

function selectTreeFile(path: string) {
  selectedTreePath.value = path;
}

const expandedTreePaths = computed(() => Array.from(expandedTreePathSet.value));

async function loadSingleDirectory(path: string) {
  const options = getOptions();
  const directory = options.activeDirectory.value.trim();
  if (!directory) return;
  try {
    const data = await opencodeApi.listFiles({ directory, path });
    if (options.activeDirectory.value.trim() !== directory) return;
    const list = Array.isArray(data) ? data : [];
    const children = buildTreeNodes(list, directory, path);
    treeNodes.value = updateTreeNodeChildren(treeNodes.value, path, children);

    const foundFiles = children.filter((node) => node.type === 'file').map((node) => node.path);
    if (foundFiles.length === 0) return;
    const merged = new Set(files.value);
    foundFiles.forEach((file) => merged.add(file));
    files.value = Array.from(merged).sort((a, b) => a.localeCompare(b));
    fileCacheVersion.value += 1;
  } catch {}
}

async function rebuildFileCache() {
  const options = getOptions();
  const directory = options.activeDirectory.value.trim();
  const buildId = ++fileCacheBuildId;
  treeLoading.value = true;
  treeError.value = '';
  if (!directory) {
    treeNodes.value = [];
    files.value = [];
    fileCacheVersion.value += 1;
    treeLoading.value = false;
    return;
  }

  const queue: string[] = ['.'];
  const visited = new Set<string>();
  const collected: string[] = [];

  try {
    while (queue.length > 0) {
      const path = queue.shift();
      if (!path || visited.has(path)) continue;
      visited.add(path);

      const data = await opencodeApi.listFiles({ directory, path });
      if (buildId !== fileCacheBuildId) return;
      if (options.activeDirectory.value.trim() !== directory) return;

      const list = Array.isArray(data) ? data : [];
      const children = buildTreeNodes(list, directory, path);
      if (path === '.') {
        treeNodes.value = children;
      } else {
        treeNodes.value = updateTreeNodeChildren(treeNodes.value, path, children);
      }

      for (const child of children) {
        if (child.type === 'file') {
          collected.push(child.path);
          continue;
        }
        if (!child.ignored && !visited.has(child.path)) {
          queue.push(child.path);
        }
      }
    }

    if (buildId !== fileCacheBuildId) return;
    if (options.activeDirectory.value.trim() !== directory) return;
    files.value = Array.from(new Set(collected)).sort((a, b) => a.localeCompare(b));
    fileCacheVersion.value += 1;
  } catch (error) {
    if (buildId !== fileCacheBuildId) return;
    if (options.activeDirectory.value.trim() !== directory) return;
    treeError.value = `Tree load failed: ${toErrorMessage(error)}`;
  } finally {
    if (buildId === fileCacheBuildId && options.activeDirectory.value.trim() === directory) {
      treeLoading.value = false;
    }
  }
}

async function reloadTree() {
  await rebuildFileCache();
}

function initializeFileTree(options: UseFileTreeOptions) {
  if (boundOptions) return;
  boundOptions = options;
  watch(
    () => options.activeDirectory.value,
    (directory) => {
      const activePath = directory.trim();
      if (!activePath) {
        treeNodes.value = [];
        expandedTreePathSet.value = new Set();
        selectedTreePath.value = '';
        treeError.value = '';
        treeLoading.value = false;
        updateSessionDiffState([]);
        files.value = [];
        fileCacheVersion.value += 1;
        return;
      }
      void reloadTree();
    },
    { immediate: true },
  );
}

export function useFileTree(options?: UseFileTreeOptions) {
  if (options) initializeFileTree(options);
  if (!boundOptions) {
    throw new Error('useFileTree is not initialized');
  }

  return {
    treeNodes,
    expandedTreePaths,
    expandedTreePathSet,
    selectedTreePath,
    treeLoading,
    treeError,
    sessionStatusByPath,
    sessionDiffEntries,
    sessionDiffByPath,
    files,
    fileCacheVersion,
    reloadTree,
    refreshSessionDiff,
    toggleTreeDirectory,
    selectTreeFile,
    updateSessionDiffState,
    normalizeSessionDiffEntries,
  };
}
