import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, reactive } from 'vue';
import { createI18n } from 'vue-i18n';

vi.mock('@iconify/vue', () => ({
  Icon: {
    name: 'IconStub',
    render() {
      return null;
    },
  },
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

type TreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: TreeNode[];
  ignored?: boolean;
  synthetic?: boolean;
};

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
        staged: 'Staged',
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

function makeFiles(names: string[]): TreeNode[] {
  return names.map((name) => ({
    name,
    path: name,
    type: 'file',
  }));
}

async function flushRender() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountTreeView(initialNodes: TreeNode[]) {
  const props = reactive({
    rootNodes: initialNodes,
    expandedPaths: [] as string[],
    selectedPath: '',
    isLoading: false,
    error: '',
    gitStatusByPath: {},
    branchInfo: null,
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

describe('TreeView', () => {
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

  it('renders all rows when the scroll container height is zero', async () => {
    const tree = await mountTreeView(
      makeFiles(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts']),
    );

    expect(tree.root.querySelectorAll('.tree-row')).toHaveLength(8);

    tree.unmount();
  });

  it('recomputes rows when root nodes change but the item count stays the same', async () => {
    const tree = await mountTreeView(makeFiles(['alpha.ts', 'beta.ts', 'gamma.ts', 'delta.ts', 'epsilon.ts']));

    tree.props.rootNodes = makeFiles(['uno.ts', 'dos.ts', 'tres.ts', 'cuatro.ts', 'cinco.ts']);
    await flushRender();

    const names = Array.from(tree.root.querySelectorAll('.tree-name')).map((node) =>
      node.textContent?.trim() ?? '',
    );
    expect(names).toEqual(['uno.ts', 'dos.ts', 'tres.ts', 'cuatro.ts', 'cinco.ts']);
    expect(tree.root.textContent).not.toContain('alpha.ts');

    tree.unmount();
  });
});
