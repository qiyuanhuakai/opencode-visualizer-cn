import { afterEach, beforeEach, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, reactive } from 'vue';
import { createI18n } from 'vue-i18n';

vi.mock('@iconify/vue', () => ({
  Icon: defineComponent({
    name: 'IconStub',
    props: {
      icon: {
        type: String,
        required: true,
      },
    },
    setup(props) {
      return () => h('span', { class: 'icon-stub', 'data-icon': props.icon });
    },
  }),
}));

vi.mock('./Dropdown.vue', () => ({
  default: defineComponent({
    name: 'DropdownStub',
    setup(_props, { slots }) {
      return () => {
        const children = [];
        if (slots.trigger) children.push(...slots.trigger());
        if (slots.default) children.push(...slots.default());
        return children;
      };
    },
  }),
}));

vi.mock('./Dropdown/Item.vue', () => ({
  default: defineComponent({
    name: 'DropdownItemStub',
    setup(_props, { slots }) {
      return () => slots.default?.() ?? null;
    },
  }),
}));

vi.mock('./Dropdown/Label.vue', () => ({
  default: defineComponent({
    name: 'DropdownLabelStub',
    setup(_props, { slots }) {
      return () => {
        const children = [];
        if (slots.default) children.push(...slots.default());
        if (slots.action) children.push(...slots.action());
        return children;
      };
    },
  }),
}));

vi.mock('./Dropdown/Search.vue', () => ({
  default: {
    name: 'DropdownSearchStub',
    render() {
      return null;
    },
  },
}));

import TreeView from './TreeView.vue';
import type { TreeNode } from '../types/tree';

function createMessages() {
  return {
    en: {
      common: {
        loading: 'Loading',
      },
      treeView: {
        searchBranches: 'Search branches',
        loadingBranches: 'Loading branches',
        local: 'Local',
        noBranches: 'No branches',
        searchFiles: 'Search files',
        treeMode: 'Tree mode',
        staged: 'Index',
        changes: 'Changes',
        allFiles: 'All files',
        noFiles: 'No files',
        collapseDirectory: 'Collapse directory',
        expandDirectory: 'Expand directory',
        reloadFileTree: 'Reload file tree',
        mergeRefTitle: 'Merge ref',
        createBranchTitle: 'Create branch',
        deleteBranchTooltip: 'Delete branch',
        fetch: 'Fetch {remote}',
        mergeTooltip: 'Merge branch',
        createBranchTooltip: 'Create branch',
        aheadOfRemote: 'Ahead',
        remoteFallback: 'remote',
        behindRemote: 'Behind',
        remote: '{name}',
        branch: {
          directory: '{name}',
          gitUnavailable: 'No git',
          headPrefix: '{short}',
          tracking: '{branch}',
          currentOnly: '{branch}',
        },
        diffStats: {
          insertions: '{count} insertions',
          deletions: '{count} deletions',
          clickToOpen: 'open',
        },
        disabledReason: {
          alreadyOnBranch: 'Already on branch',
          worktreeInUse: 'Worktree in use',
          localExists: 'Local exists',
        },
        confirm: {
          createBranchFrom: 'Create branch',
          mergeIntoCurrent: 'Merge branch',
          deleteBranch: 'Delete branch',
          runCommand: 'Run command',
        },
      },
    },
  };
}

export function makeFiles(names: string[]): TreeNode[] {
  return names.map((name) => ({
    name,
    path: name,
    type: 'file',
  }));
}

export async function flushRender() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

export async function searchFiles(root: HTMLElement, query: string) {
  const input = root.querySelector<HTMLInputElement>('.tree-file-search-input');
  if (!input) throw new Error('File search input is missing');
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushRender();
}

export async function mountTreeView(initialNodes: TreeNode[], branchName?: string) {
  const props = reactive({
    rootNodes: initialNodes,
    expandedPaths: [] as string[],
    selectedPath: '',
    isLoading: false,
    error: '',
    gitStatusByPath: {},
    branchInfo: branchName ? { branch: branchName, ahead: 0, behind: 0 } : null,
    diffStats: null,
    directoryName: 'repo',
    branchEntries: [],
    branchListLoading: false,
  });

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: createMessages(),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(TreeView, props);
      },
    }),
  );

  app.use(i18n);
  app.provide('showConfirm', async () => true);
  app.provide('showPrompt', async () => null);
  app.mount(root);
  await flushRender();

  return {
    props,
    root,
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}

export function setupTreeViewTestEnvironment() {
  beforeEach(() => {
    if (typeof ResizeObserver === 'undefined') {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
        },
      );
    }
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });
}
