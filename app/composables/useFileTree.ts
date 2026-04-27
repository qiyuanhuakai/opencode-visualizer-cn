import { computed, ref, watch } from 'vue';
import type { Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileWatcherUpdatedPacket } from '../types/sse';
import type {
  GitStatus,
  GitStatusCode,
  GitFileStatus,
  GitBranchInfo,
  BranchEntry,
} from '../types/git';
import * as opencodeApi from '../utils/opencode';
import { normalizeDirectory } from '../utils/path';
import { uniqueBy } from '../utils/array';
import { usePtyOneshot } from './usePtyOneshot';

const GIT_ENV_PREAMBLE = [
  'stty -opost -echo 2>/dev/null',
  'export GIT_PAGER=cat',
  'export GIT_TERMINAL_PROMPT=0',
  'export NO_COLOR=1',
  'export GIT_CONFIG_NOSYSTEM=1',
  'export TERM=dumb',
  'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0',
].join('\n');

const GIT_STATUS_SCRIPT = [
  GIT_ENV_PREAMBLE,
  'git -c color.status=false -c color.ui=false --no-pager status --porcelain=v1 -z -b -uall 2>/dev/null',
  "printf '\\0##HEAD\\0'",
  'git rev-parse --short HEAD 2>/dev/null',
  "printf '\\0##DIFFSTAT\\0'",
  'git diff --shortstat 2>/dev/null',
  "printf '\\0##DIFFSTAT_CACHED\\0'",
  'git diff --cached --shortstat 2>/dev/null',
  "printf '\\0##UNTRACKED_STAT\\0'",
  'untracked=0; while IFS= read -r -d \'\' f; do untracked=$((untracked + $(wc -l < "$f"))); done < <(git ls-files --others --exclude-standard -z); printf \'%s\' "$untracked"',
].join('\n');

const GIT_FILE_LIST_SCRIPT = [
  GIT_ENV_PREAMBLE,
  'git ls-files --cached --others --exclude-standard -z 2>/dev/null',
].join('\n');

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

type FileTreeStrategy = 'filesystem' | 'git';

type UseFileTreeOptions = {
  activeDirectory: Ref<string>;
};

type DirectorySidebarSnapshot = {
  treeNodes: TreeNode[];
  files: string[];
  gitStatus: GitStatus | null;
  branchEntries: BranchEntry[];
  fileTreeStrategy: FileTreeStrategy;
  branchEntriesLoaded: boolean;
};

type RefreshGitStatusOptions = {
  includeFileSnapshot?: boolean;
};

type RefreshBranchEntriesOptions = {
  force?: boolean;
};

let boundOptions: UseFileTreeOptions | null = null;

const treeNodes = ref<TreeNode[]>([]);
const expandedTreePathSet = ref(new Set<string>());
const selectedTreePath = ref('');
const treeLoading = ref(false);
const treeError = ref('');
const gitStatus = ref<GitStatus | null>(null);
const gitStatusByPath = ref<Record<string, GitFileStatus>>({});
const files = ref<string[]>([]);
const fileCacheVersion = ref(0);
const branchEntries = ref<BranchEntry[]>([]);
const branchListLoading = ref(false);
const fileTreeStrategy = ref<FileTreeStrategy>('filesystem');

let fileCacheBuildId = 0;
let tFunction: ((key: string, params?: Record<string, unknown>) => string) | null = null;
const DIRECTORY_RELOAD_DEBOUNCE_MS = 120;
const GIT_STATUS_RELOAD_DEBOUNCE_MS = 120;
const RETRY_ONCE_DELAY_MS = 180;
const DIRECTORY_SNAPSHOT_CACHE_LIMIT = 12;
const scheduledDirectoryReloads = new Map<string, ReturnType<typeof setTimeout>>();
const directorySidebarCache = new Map<string, DirectorySidebarSnapshot>();
let scheduledGitStatusReload: ReturnType<typeof setTimeout> | null = null;
let gitStatusGeneration = 0;
let branchListGeneration = 0;
let gitFileListGeneration = 0;
let branchEntriesLoadedForDirectory = false;
let gitStatusRefreshInFlight: Promise<void> | null = null;
let gitStatusRefreshQueued = false;
const pendingFileWatcherEvents: FileWatcherUpdatedPacket[] = [];

const BRANCH_LIST_FORMAT =
  '%(refname)\t%(refname:short)\t%(HEAD)\t%(worktreepath)\t%(objectname:short)\t%(subject)\t%(upstream:short)';

function getOptions(): UseFileTreeOptions {
  if (!boundOptions) {
    throw new Error('useFileTree must be initialized with options before use');
  }
  return boundOptions;
}

function normalizeRelativePath(path: string) {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '.') return '.';
  const segments = trimmed.replace(/\\/g, '/').split('/');
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (cleaned.length > 0) cleaned.pop();
      continue;
    }
    cleaned.push(segment);
  }
  return cleaned.join('/') || '.';
}

function toRelativePath(path: string, directory: string) {
  const normalizedDirectory = normalizeDirectory(directory);
  const normalizedPath = normalizeDirectory(path);
  if (normalizedPath === normalizedDirectory) return '.';
  const prefix = `${normalizedDirectory}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizeRelativePath(normalizedPath.slice(prefix.length));
  }
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

function clearScheduledDirectoryReloads() {
  scheduledDirectoryReloads.forEach((timer) => {
    clearTimeout(timer);
  });
  scheduledDirectoryReloads.clear();
}

function clearScheduledGitStatusReload() {
  if (!scheduledGitStatusReload) return;
  clearTimeout(scheduledGitStatusReload);
  scheduledGitStatusReload = null;
}

function isPathInsideDirectory(path: string, directory: string) {
  const normalizedDirectory = normalizeDirectory(directory);
  const normalizedPath = normalizeDirectory(path);
  if (!normalizedDirectory || !normalizedPath) return false;
  return (
    normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}/`)
  );
}

function parentDirectoryPath(relativePath: string) {
  if (!relativePath.includes('/')) return '.';
  return relativePath.slice(0, relativePath.lastIndexOf('/')) || '.';
}

function mergeTreeNodeChildren(existing: TreeNode[], incoming: TreeNode[]) {
  if (existing.length === 0 || incoming.length === 0) return incoming;
  const existingByPath = new Map(existing.map((node) => [node.path, node]));
  return incoming.map((node) => {
    const previous = existingByPath.get(node.path);
    if (
      node.type === 'directory' &&
      previous?.type === 'directory' &&
      previous.loaded &&
      Array.isArray(previous.children)
    ) {
      return {
        ...node,
        children: previous.children,
        loaded: true,
      };
    }
    return node;
  });
}

function replaceDirectoryFilesInCache(parentPath: string, children: TreeNode[]) {
  const directFiles = children.filter((node) => node.type === 'file').map((node) => node.path);
  const preserved = files.value.filter((filePath) => {
    if (parentPath === '.') {
      return filePath.includes('/');
    }
    const prefix = `${parentPath}/`;
    if (!filePath.startsWith(prefix)) return true;
    return filePath.slice(prefix.length).includes('/');
  });
  const next = uniqueBy([...preserved, ...directFiles], x => x).sort((a, b) =>
    a.localeCompare(b),
  );
  const changed =
    next.length !== files.value.length || next.some((path, index) => path !== files.value[index]);
  if (!changed) return;
  files.value = next;
  fileCacheVersion.value += 1;
}

function scheduleDirectoryReload(path: string) {
  const timer = scheduledDirectoryReloads.get(path);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  scheduledDirectoryReloads.set(
    path,
    setTimeout(() => {
      scheduledDirectoryReloads.delete(path);
      void loadSingleDirectory(path);
    }, DIRECTORY_RELOAD_DEBOUNCE_MS),
  );
}

function scheduleGitStatusReload() {
  clearScheduledGitStatusReload();
  scheduledGitStatusReload = setTimeout(() => {
    scheduledGitStatusReload = null;
    void refreshGitStatus();
  }, GIT_STATUS_RELOAD_DEBOUNCE_MS);
}

function isGitInternalPath(relativePath: string) {
  return relativePath === '.git' || relativePath.startsWith('.git/');
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeGitStatusCode(value: string): GitStatusCode {
  if (value === ' ') return '';
  if (value === '?') return '?';
  if (value === 'M') return 'M';
  if (value === 'A') return 'A';
  if (value === 'D') return 'D';
  if (value === 'R') return 'R';
  if (value === 'C') return 'C';
  return '';
}

function parseGitStatusBranch(line: string): GitBranchInfo {
  const raw = line.replace(/^##\s*/, '').trim();
  let ahead = 0;
  let behind = 0;
  let branchPart = raw;

  const markerStart = raw.indexOf(' [');
  if (markerStart >= 0 && raw.endsWith(']')) {
    branchPart = raw.slice(0, markerStart);
    const marker = raw.slice(markerStart + 2, -1);
    const aheadMatch = marker.match(/ahead\s+(\d+)/);
    const behindMatch = marker.match(/behind\s+(\d+)/);
    ahead = aheadMatch ? Number.parseInt(aheadMatch[1], 10) || 0 : 0;
    behind = behindMatch ? Number.parseInt(behindMatch[1], 10) || 0 : 0;
  }

  const divergenceIndex = branchPart.indexOf('...');
  if (divergenceIndex < 0) {
    return {
      branch: branchPart || '(detached)',
      ahead,
      behind,
    };
  }

  const branch = branchPart.slice(0, divergenceIndex).trim() || '(detached)';
  const upstream = branchPart.slice(divergenceIndex + 3).trim();
  return {
    branch,
    upstream: upstream || undefined,
    ahead,
    behind,
  };
}

function stripAnsi(value: string) {
  const ansiPattern = new RegExp(`${String.raw`\u001b`}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return value.replace(ansiPattern, '');
}

function parseShortstatLine(line: string): { additions: number; deletions: number } {
  const addMatch = line.match(/(\d+)\s+insertion/);
  const delMatch = line.match(/(\d+)\s+deletion/);
  return {
    additions: addMatch ? Number.parseInt(addMatch[1], 10) || 0 : 0,
    deletions: delMatch ? Number.parseInt(delMatch[1], 10) || 0 : 0,
  };
}

function parseGitStatusOutput(output: string): GitStatus {
  const cleaned = stripAnsi(output).replace(/\r/g, '');
  const tokens = cleaned.split('\0');

  let branch: GitBranchInfo = {
    branch: '(detached)',
    ahead: 0,
    behind: 0,
  };
  const entries: GitFileStatus[] = [];
  let section: 'status' | 'head' | 'diffstat' | 'diffstat_cached' | 'untracked_stat' = 'status';
  let headShort = '';
  let unstagedAdditions = 0;
  let unstagedDeletions = 0;
  let stagedAdditions = 0;
  let stagedDeletions = 0;
  let pendingRename: { index: GitStatusCode; worktree: GitStatusCode; path: string } | null = null;

  for (const rawToken of tokens) {
    const trimmed = rawToken.trim();
    if (!trimmed) continue;

    // Section markers (may contain embedded newlines from surrounding commands)
    const stripped = trimmed.replace(/\n/g, '').trim();
    if (stripped === '##HEAD') {
      section = 'head';
      continue;
    }
    if (stripped === '##DIFFSTAT') {
      section = 'diffstat';
      continue;
    }
    if (stripped === '##DIFFSTAT_CACHED') {
      section = 'diffstat_cached';
      continue;
    }
    if (stripped === '##UNTRACKED_STAT') {
      section = 'untracked_stat';
      continue;
    }

    if (section === 'head') {
      const lines = rawToken.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!headShort && /^[0-9a-f]+$/i.test(t)) {
          headShort = t;
        }
      }
      continue;
    }

    if (section === 'diffstat' || section === 'diffstat_cached') {
      const lines = rawToken.split('\n');
      for (const line of lines) {
        const stat = parseShortstatLine(line);
        if (section === 'diffstat') {
          unstagedAdditions += stat.additions;
          unstagedDeletions += stat.deletions;
        } else {
          stagedAdditions += stat.additions;
          stagedDeletions += stat.deletions;
        }
      }
      continue;
    }

    if (section === 'untracked_stat') {
      const lines = rawToken.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (t && /^\d+$/.test(t)) {
          unstagedAdditions += Number.parseInt(t, 10) || 0;
        }
      }
      continue;
    }

    // Use rawToken (not trimmed) — X can be space (e.g. " M path")
    if (pendingRename) {
      entries.push({
        path: pendingRename.path,
        index: pendingRename.index,
        worktree: pendingRename.worktree,
        origPath: trimmed,
      });
      pendingRename = null;
      continue;
    }

    if (trimmed.startsWith('## ')) {
      branch = parseGitStatusBranch(trimmed);
      continue;
    }

    if (rawToken.length >= 4 && rawToken[2] === ' ') {
      const x = normalizeGitStatusCode(rawToken[0]);
      const y = normalizeGitStatusCode(rawToken[1]);
      const path = rawToken.slice(3);
      if (!path) continue;

      if (x === 'R' || x === 'C') {
        pendingRename = { index: x, worktree: y, path };
        continue;
      }

      entries.push({ path, index: x, worktree: y });
    }
  }

  if (headShort) {
    branch.headShort = headShort;
  }

  return {
    branch,
    files: entries,
    diffStats: {
      staged: { additions: stagedAdditions, deletions: stagedDeletions },
      unstaged: { additions: unstagedAdditions, deletions: unstagedDeletions },
    },
  };
}

function cloneTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? cloneTreeNodes(node.children) : undefined,
  }));
}

function cloneGitStatus(status: GitStatus | null): GitStatus | null {
  if (!status) return null;
  return {
    branch: { ...status.branch },
    files: status.files.map((entry) => ({ ...entry })),
    diffStats: {
      staged: { ...status.diffStats.staged },
      unstaged: { ...status.diffStats.unstaged },
    },
  };
}

function cloneBranchEntries(entries: BranchEntry[]): BranchEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

function setDirectorySidebarSnapshot(directory: string, snapshot: DirectorySidebarSnapshot) {
  const normalizedDirectory = directory.trim();
  if (!normalizedDirectory) return;
  directorySidebarCache.delete(normalizedDirectory);
  directorySidebarCache.set(normalizedDirectory, snapshot);
  while (directorySidebarCache.size > DIRECTORY_SNAPSHOT_CACHE_LIMIT) {
    const oldestKey = directorySidebarCache.keys().next().value;
    if (!oldestKey) break;
    directorySidebarCache.delete(oldestKey);
  }
}

function cacheCurrentDirectoryState(directory: string) {
  const normalizedDirectory = directory.trim();
  if (!normalizedDirectory) return;
  setDirectorySidebarSnapshot(normalizedDirectory, {
    treeNodes: cloneTreeNodes(treeNodes.value),
    files: [...files.value],
    gitStatus: cloneGitStatus(gitStatus.value),
    branchEntries: cloneBranchEntries(branchEntries.value),
    fileTreeStrategy: fileTreeStrategy.value,
    branchEntriesLoaded: branchEntriesLoadedForDirectory,
  });
}

function restoreDirectoryStateFromCache(directory: string): boolean {
  const snapshot = directorySidebarCache.get(directory.trim());
  if (!snapshot) return false;
  treeNodes.value = cloneTreeNodes(snapshot.treeNodes);
  files.value = [...snapshot.files];
  fileCacheVersion.value += 1;
  treeError.value = '';
  fileTreeStrategy.value = snapshot.fileTreeStrategy;
  setGitStatus(cloneGitStatus(snapshot.gitStatus));
  branchEntries.value = cloneBranchEntries(snapshot.branchEntries);
  branchEntriesLoadedForDirectory = false;
  return true;
}

function invalidateDirectorySidebarCache(directory: string) {
  const normalizedDirectory = directory.trim();
  if (!normalizedDirectory) return;
  directorySidebarCache.delete(normalizedDirectory);
  const activeDirectory = boundOptions?.activeDirectory.value.trim() ?? '';
  if (activeDirectory === normalizedDirectory) {
    branchEntriesLoadedForDirectory = false;
  }
}

function resetSidebarState() {
  treeNodes.value = [];
  expandedTreePathSet.value = new Set();
  selectedTreePath.value = '';
  treeError.value = '';
  files.value = [];
  fileCacheVersion.value += 1;
  fileTreeStrategy.value = 'filesystem';
  setGitStatus(null);
  branchEntries.value = [];
  branchEntriesLoadedForDirectory = false;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function retryOnce<T>(runner: (attempt: number) => Promise<T>, shouldRetry: () => boolean) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await runner(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === 1 || !shouldRetry()) {
        throw error;
      }
      await sleep(RETRY_ONCE_DELAY_MS);
      if (!shouldRetry()) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function listFilesWithRetry(directory: string, path: string) {
  const data = await retryOnce(
    async () => await opencodeApi.listFiles({ directory, path }),
    () => getOptions().activeDirectory.value.trim() === directory,
  );
  return Array.isArray(data) ? data : [];
}

function buildFullTreeFromPaths(allPaths: string[]): TreeNode[] {
  function build(paths: string[], prefix: string): TreeNode[] {
    const dirs = new Map<string, string[]>();
    const fileNames: string[] = [];

    for (const p of paths) {
      const slashIndex = p.indexOf('/');
      if (slashIndex < 0) {
        fileNames.push(p);
      } else {
        const topName = p.slice(0, slashIndex);
        const rest = p.slice(slashIndex + 1);
        let bucket = dirs.get(topName);
        if (!bucket) {
          bucket = [];
          dirs.set(topName, bucket);
        }
        bucket.push(rest);
      }
    }

    const nodes: TreeNode[] = [];

    for (const [name, childPaths] of dirs) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      nodes.push({
        name,
        path: fullPath,
        type: 'directory',
        children: build(childPaths, fullPath),
        loaded: false,
        ignored: false,
        synthetic: false,
      });
    }

    for (const name of fileNames) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      nodes.push({
        name,
        path: fullPath,
        type: 'file',
        loaded: false,
        ignored: false,
        synthetic: false,
      });
    }

    return sortTreeNodes(nodes);
  }

  return build(allPaths, '');
}

async function detectFileTreeStrategy(directory: string): Promise<FileTreeStrategy> {
  try {
    const raw = await retryOnce(
      async () => await opencodeApi.getVcsInfo(directory),
      () => getOptions().activeDirectory.value.trim() === directory,
    );
    if (!raw || typeof raw !== 'object') return 'filesystem';
    const branch = (raw as Record<string, unknown>).branch;
    if (typeof branch !== 'string' || !branch.trim()) return 'filesystem';
    return 'git';
  } catch {
    return 'filesystem';
  }
}

function deepMergeGitTree(existing: TreeNode[], incoming: TreeNode[]): TreeNode[] {
  if (existing.length === 0) return incoming;
  const existingByPath = new Map(existing.map((node) => [node.path, node]));
  const incomingByPath = new Map(incoming.map((node) => [node.path, node]));

  const merged = incoming.map((node) => {
    const prev = existingByPath.get(node.path);
    if (!prev || node.type !== 'directory' || prev.type !== 'directory') return node;

    if (prev.loaded && Array.isArray(prev.children)) {
      // Already expanded via /file — keep its children (includes ignored items)
      return { ...node, children: prev.children, loaded: true };
    }

    // Not loaded, but recurse to preserve any loaded subdirectories deeper down
    if (Array.isArray(prev.children) && Array.isArray(node.children)) {
      return { ...node, children: deepMergeGitTree(prev.children, node.children) };
    }

    return node;
  });

  // Preserve existing nodes not in incoming (e.g., ignored root entries from /file)
  for (const [path, node] of existingByPath) {
    if (!incomingByPath.has(path)) {
      merged.push(node);
    }
  }

  return sortTreeNodes(merged);
}

function mergeApiWithGitChildren(apiChildren: TreeNode[], gitChildren: TreeNode[]): TreeNode[] {
  const gitByPath = new Map(gitChildren.map((node) => [node.path, node]));
  const apiByPath = new Map(apiChildren.map((node) => [node.path, node]));

  const merged: TreeNode[] = [];

  for (const apiNode of apiChildren) {
    const gitNode = gitByPath.get(apiNode.path);
    if (gitNode && gitNode.type === 'directory' && Array.isArray(gitNode.children)) {
      // Directory exists in both — use API metadata but keep git-derived subtree
      merged.push({
        ...apiNode,
        children: gitNode.children,
      });
    } else {
      merged.push(apiNode);
    }
  }

  for (const [path, gitNode] of gitByPath) {
    if (!apiByPath.has(path)) {
      merged.push(gitNode);
    }
  }

  return sortTreeNodes(merged);
}

async function loadIgnoredRootNodes(directory: string): Promise<TreeNode[]> {
  try {
    const list = await listFilesWithRetry(directory, '.');
    const nodes = buildTreeNodes(list, directory, '.');
    return nodes.filter((node) => node.ignored);
  } catch {
    return [];
  }
}

function parseGitFileList(output: string): string[] {
  return output
    .replace(/\r/g, '')
    .split('\0')
    .map((token) => token.trim())
    .filter(Boolean);
}

async function refreshGitFileSnapshot() {
  const { activeDirectory } = getOptions();
  const directory = activeDirectory.value.trim();
  if (!directory) return;

  const { runOneShotPtyCommand } = usePtyOneshot();
  await retryOnce(
    async () => {
      const generation = ++gitFileListGeneration;
      const output = await runOneShotPtyCommand('bash', [
        '--noprofile',
        '--norc',
        '-c',
        GIT_FILE_LIST_SCRIPT,
      ]);
      if (generation !== gitFileListGeneration) return;
      if (activeDirectory.value.trim() !== directory) return;

      const allPaths = parseGitFileList(output);
      if (allPaths.length === 0) {
        treeNodes.value = [];
        files.value = [];
        fileCacheVersion.value += 1;
        cacheCurrentDirectoryState(directory);
        return;
      }

      const gitTree = buildFullTreeFromPaths(allPaths);
      const ignoredRoot = await loadIgnoredRootNodes(directory);
      if (generation !== gitFileListGeneration) return;
      if (activeDirectory.value.trim() !== directory) return;

      const mergedRoot = ignoredRoot.length > 0 ? deepMergeGitTree(ignoredRoot, gitTree) : gitTree;
      // On manual refresh, replace the tree entirely rather than merging with old state.
      // This ensures deleted files are removed from the sidebar.
      treeNodes.value = mergedRoot;

      const sorted = uniqueBy(allPaths, x => x).sort((a, b) => a.localeCompare(b));
      if (
        sorted.length !== files.value.length ||
        sorted.some((path, index) => path !== files.value[index])
      ) {
        files.value = sorted;
        fileCacheVersion.value += 1;
      }
      cacheCurrentDirectoryState(directory);
    },
    () => activeDirectory.value.trim() === directory,
  );
}

function setGitStatus(next: GitStatus | null) {
  gitStatus.value = next;
  if (!next) {
    gitStatusByPath.value = {};
    return;
  }
  const byPath: Record<string, GitFileStatus> = {};
  next.files.forEach((entry) => {
    byPath[entry.path] = entry;
  });
  gitStatusByPath.value = byPath;
}

async function refreshGitStatusOnly() {
  const { activeDirectory } = getOptions();
  const directory = activeDirectory.value.trim();
  if (!directory) {
    setGitStatus(null);
    return;
  }

  const { runOneShotPtyCommand } = usePtyOneshot();
  await retryOnce(
    async () => {
      const generation = ++gitStatusGeneration;
      const output = await runOneShotPtyCommand('bash', [
        '--noprofile',
        '--norc',
        '-c',
        GIT_STATUS_SCRIPT,
      ]);
      if (generation !== gitStatusGeneration) return;
      if (!output.includes('##HEAD')) {
        setGitStatus(null);
        cacheCurrentDirectoryState(directory);
        return;
      }
      const parsed = parseGitStatusOutput(output);
      const filesByPath = new Map(parsed.files.map((entry) => [entry.path, entry]));
      parsed.files = Array.from(filesByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
      setGitStatus(parsed);
      cacheCurrentDirectoryState(directory);
    },
    () => activeDirectory.value.trim() === directory,
  );
}

async function refreshGitStatus(options: RefreshGitStatusOptions = {}) {
  if (gitStatusRefreshInFlight) {
    gitStatusRefreshQueued = true;
    return gitStatusRefreshInFlight;
  }

  const includeFileSnapshot = options.includeFileSnapshot ?? true;
  gitStatusRefreshInFlight = (async () => {
    try {
      if (!includeFileSnapshot || fileTreeStrategy.value !== 'git') {
        await refreshGitStatusOnly().catch(() => {});
        return;
      }
      const [statusResult] = await Promise.allSettled([
        refreshGitStatusOnly(),
        refreshGitFileSnapshot(),
      ]);
      if (statusResult.status === 'rejected') {
        return;
      }
    } finally {
      gitStatusRefreshInFlight = null;
      if (gitStatusRefreshQueued) {
        gitStatusRefreshQueued = false;
        queueMicrotask(() => {
          void refreshGitStatus();
        });
      }
    }
  })();

  return gitStatusRefreshInFlight;
}

function parseBranchEntries(output: string): BranchEntry[] {
  const entries: BranchEntry[] = [];
  const lines = output.split(/\r?\n/);

  lines.forEach((line) => {
    if (!line) return;
    const parts = line.split('\t');
    if (parts.length < 7) return;
    const [refname = '', refnameShort = '', head = '', worktreePath = '', hash = '', ...rest] =
      parts;
    const upstream = rest.at(-1)?.trim() ?? '';
    const subject = rest.slice(0, -1).join('\t').trim();

    const headMark = head.trim();
    const isCurrent = headMark === '*';
    const isWorktree = worktreePath.trim().length > 0;

    if (refname.startsWith('refs/heads/')) {
      const displayName = refname.slice('refs/heads/'.length);
      if (!displayName) return;
      entries.push({
        refname,
        refnameShort,
        displayName,
        hash,
        subject,
        isCurrent,
        isWorktree,
        isLocal: true,
        remote: '',
        upstream,
        hasLocalCounterpart: false,
      });
      return;
    }

    if (!refname.startsWith('refs/remotes/')) return;
    const remoteRelative = refname.slice('refs/remotes/'.length);
    const splitIndex = remoteRelative.indexOf('/');
    if (splitIndex <= 0) return;
    const remote = remoteRelative.slice(0, splitIndex);
    const displayName = remoteRelative.slice(splitIndex + 1);
    if (!displayName || displayName === 'HEAD') return;
    entries.push({
      refname,
      refnameShort,
      displayName,
      hash,
      subject,
      isCurrent,
      isWorktree,
      isLocal: false,
      remote,
      upstream,
      hasLocalCounterpart: false,
    });
  });

  const localNames = new Set(
    entries.filter((entry) => entry.isLocal).map((entry) => entry.displayName),
  );

  entries.forEach((entry) => {
    if (entry.isLocal) return;
    entry.hasLocalCounterpart = localNames.has(entry.displayName);
  });

  return entries;
}

async function refreshBranchEntries(options: RefreshBranchEntriesOptions = {}) {
  const { activeDirectory } = getOptions();
  const directory = activeDirectory.value.trim();
  if (!directory) {
    branchEntries.value = [];
    branchListLoading.value = false;
    branchEntriesLoadedForDirectory = false;
    return;
  }

  if (!options.force && branchEntriesLoadedForDirectory) {
    return;
  }

  if (!options.force && branchListLoading.value) {
    return;
  }

  branchListLoading.value = true;
  const { runOneShotPtyCommand } = usePtyOneshot();
  try {
    await retryOnce(
      async () => {
        const generation = ++branchListGeneration;
        const output = await runOneShotPtyCommand('git', [
          '--no-pager',
          '-c',
          'color.ui=false',
          '-c',
          'color.branch=false',
          'branch',
          '--no-color',
          '-a',
          '--sort=-committerdate',
          `--format=${BRANCH_LIST_FORMAT}`,
        ]);
        if (generation !== branchListGeneration) return;
        branchEntries.value = parseBranchEntries(output);
        branchEntriesLoadedForDirectory = true;
        cacheCurrentDirectoryState(directory);
      },
      () => activeDirectory.value.trim() === directory,
    );
  } catch {
    if (activeDirectory.value.trim() !== directory) return;
    branchEntriesLoadedForDirectory = false;
  } finally {
    if (activeDirectory.value.trim() === directory) {
      branchListLoading.value = false;
    }
  }
}

async function ensureBranchEntriesLoaded(force = false) {
  await refreshBranchEntries({ force });
}

function toggleTreeDirectory(path: string) {
  const next = new Set(expandedTreePathSet.value);
  if (next.has(path)) {
    next.delete(path);
    expandedTreePathSet.value = next;
    return;
  }
  next.add(path);
  expandedTreePathSet.value = next;
  const node = findTreeNodeByPath(treeNodes.value, path);
  if (node?.loaded) return;
  void loadSingleDirectory(path);
}

function selectTreeFile(path: string) {
  selectedTreePath.value = selectedTreePath.value === path ? '' : path;
}

const expandedTreePaths = computed(() => Array.from(expandedTreePathSet.value));

async function loadSingleDirectory(path: string) {
  if (fileTreeStrategy.value === 'git') {
    if (path === '.') {
      await refreshGitFileSnapshot();
      return;
    }
    const options = getOptions();
    const directory = options.activeDirectory.value.trim();
    if (!directory) return;
    try {
      const list = await listFilesWithRetry(directory, path);
      if (options.activeDirectory.value.trim() !== directory) return;
      const apiChildren = buildTreeNodes(list, directory, path);
      const parent = findTreeNodeByPath(treeNodes.value, path);
      const gitChildren = parent?.children ?? [];
       const merged = mergeApiWithGitChildren(apiChildren, gitChildren);
       treeNodes.value = updateTreeNodeChildren(treeNodes.value, path, merged);
       cacheCurrentDirectoryState(directory);
     } catch (error) {
       console.error('[useFileTree] loadSingleDirectory (git) failed:', error);
       return;
     }
    return;
  }

  const options = getOptions();
  const directory = options.activeDirectory.value.trim();
  if (!directory) return;
  try {
    const list = await listFilesWithRetry(directory, path);
    if (options.activeDirectory.value.trim() !== directory) return;
    const children = buildTreeNodes(list, directory, path);
    if (path === '.') {
      const mergedRootNodes = mergeTreeNodeChildren(treeNodes.value, children);
      treeNodes.value = mergedRootNodes;
      replaceDirectoryFilesInCache(path, mergedRootNodes);
      cacheCurrentDirectoryState(directory);
      return;
    }

     const parent = findTreeNodeByPath(treeNodes.value, path);
     const mergedChildren = mergeTreeNodeChildren(parent?.children ?? [], children);
     treeNodes.value = updateTreeNodeChildren(treeNodes.value, path, mergedChildren);
     replaceDirectoryFilesInCache(path, mergedChildren);
     cacheCurrentDirectoryState(directory);
   } catch (error) {
     console.error('[useFileTree] loadSingleDirectory (fs) failed:', error);
   }
}

function feed(packet: FileWatcherUpdatedPacket) {
  const options = getOptions();
  const directory = options.activeDirectory.value.trim();
  if (!directory) return;
  if (!isPathInsideDirectory(packet.file, directory)) return;
  if (treeLoading.value) {
    pendingFileWatcherEvents.push(packet);
    return;
  }

  const relativePath = toRelativePath(packet.file, directory);
  if (relativePath === '.') return;
  if (isGitInternalPath(relativePath)) return;

  if (fileTreeStrategy.value !== 'git' && packet.event === 'unlink') {
    const next = files.value.filter(
      (path) => path !== relativePath && !path.startsWith(`${relativePath}/`),
    );
    if (next.length !== files.value.length) {
      files.value = next;
      fileCacheVersion.value += 1;
    }
  }

  scheduleDirectoryReload(parentDirectoryPath(relativePath));
  scheduleGitStatusReload();
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

  const strategy = await detectFileTreeStrategy(directory);
  if (buildId !== fileCacheBuildId) return;
  if (options.activeDirectory.value.trim() !== directory) return;
  fileTreeStrategy.value = strategy;

  if (strategy === 'git') {
    try {
      await refreshGitFileSnapshot();
      if (buildId !== fileCacheBuildId) return;
      if (options.activeDirectory.value.trim() !== directory) return;
    } catch (error) {
      if (buildId !== fileCacheBuildId) return;
      if (options.activeDirectory.value.trim() !== directory) return;
      treeError.value = getT()('app.error.treeLoadFailed', { message: toErrorMessage(error) });
    } finally {
      if (buildId === fileCacheBuildId && options.activeDirectory.value.trim() === directory) {
        treeLoading.value = false;
        // Drain queued file watcher events
        while (pendingFileWatcherEvents.length > 0) {
          const queued = pendingFileWatcherEvents.shift()!;
          feed(queued);
        }
      }
    }
    return;
  }

  const AUTO_SCAN_FILE_LIMIT = 3000;
  const queue: string[] = ['.'];
  const visited = new Set<string>();
  const collected: string[] = [];

  try {
    while (queue.length > 0) {
      const path = queue.shift();
      if (!path || visited.has(path)) continue;
      visited.add(path);

      const list = await listFilesWithRetry(directory, path);
      if (buildId !== fileCacheBuildId) return;
      if (options.activeDirectory.value.trim() !== directory) return;

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

      if (collected.length > AUTO_SCAN_FILE_LIMIT) break;
    }

    if (buildId !== fileCacheBuildId) return;
    if (options.activeDirectory.value.trim() !== directory) return;
    files.value = uniqueBy(collected, x => x).sort((a, b) => a.localeCompare(b));
    fileCacheVersion.value += 1;
    cacheCurrentDirectoryState(directory);
  } catch (error) {
    if (buildId !== fileCacheBuildId) return;
    if (options.activeDirectory.value.trim() !== directory) return;
    treeError.value = getT()('app.error.treeLoadFailed', { message: toErrorMessage(error) });
  } finally {
    if (buildId === fileCacheBuildId && options.activeDirectory.value.trim() === directory) {
      treeLoading.value = false;
      // Drain queued file watcher events
      while (pendingFileWatcherEvents.length > 0) {
        const queued = pendingFileWatcherEvents.shift()!;
        feed(queued);
      }
    }
  }
}

async function reloadTree() {
  await rebuildFileCache();
}

function initializeFileTree(options: UseFileTreeOptions) {
  if (boundOptions) return;
  boundOptions = options;
  usePtyOneshot({ activeDirectory: options.activeDirectory, translate: tFunction ?? undefined });
  watch(
    () => options.activeDirectory.value,
    (directory) => {
      clearScheduledDirectoryReloads();
      clearScheduledGitStatusReload();

      fileCacheBuildId += 1;
      gitStatusGeneration += 1;
      gitFileListGeneration += 1;
      branchListGeneration += 1;
      treeLoading.value = false;
      branchListLoading.value = false;
      expandedTreePathSet.value = new Set();
      selectedTreePath.value = '';

      const activePath = directory.trim();
      if (!activePath) {
        resetSidebarState();
        return;
      }
      if (!restoreDirectoryStateFromCache(activePath)) {
        resetSidebarState();
      }
      void reloadTree();
      void refreshGitStatus({ includeFileSnapshot: false });
    },
    { immediate: true },
  );
}

function getT() {
  if (!tFunction) {
    return (key: string, params?: Record<string, unknown>) => {
      const lastPart = key.split('.').pop() || key;
      if (params) {
        return Object.entries(params).reduce((acc, [k, v]) => {
          return acc.replace(`{${k}}`, String(v));
        }, lastPart);
      }
      return lastPart;
    };
  }
  return tFunction;
}



export function useFileTree(options?: UseFileTreeOptions) {
  const { t } = useI18n();
  tFunction = t;

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
    gitStatus,
    gitStatusByPath,
    files,
    fileCacheVersion,
    reloadTree,
    refreshGitStatus,
    ensureBranchEntriesLoaded,
    invalidateDirectorySidebarCache,
    toggleTreeDirectory,
    selectTreeFile,
    branchEntries,
    branchListLoading,
    refreshBranchEntries,
    feed,
  };
}
