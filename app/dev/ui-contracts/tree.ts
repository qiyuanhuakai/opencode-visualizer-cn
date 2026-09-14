import { defineComponent, h, nextTick, ref } from 'vue';
import SnippetCompletion from '../../components/SnippetCompletion.vue';
import TreeView from '../../components/TreeView.vue';
import type { TreeNode } from '../../types/tree';
import { fixtureApi, installApp, waitForRender } from './runtime';

export function treeScenario(): void {
  const sidebarSize = ref(12);
  const longBranch = 'feature/国际化-branch-with-a-name-that-must-yield-space-to-search-controls';
  const rootNodes: TreeNode[] = Array.from({ length: 80 }, (_, index) => ({
    name: index === 0 ? '一个非常长的文件名用于验证侧栏截断与可读性.vue' : `component-${index}.vue`,
    path: `/workspace/component-${index}.vue`,
    type: 'file',
  }));
  const snippet = {
    id: 'cjk-stress',
    trigger: 'review',
    name: '审查长文本',
    body: '请检查实现并保持所有可访问性语义。'.repeat(24),
    description: '这是一段没有空格的中文说明用于验证狭窄视口中的换行和完整内容提示。'.repeat(20),
    enabled: true,
    tags: ['中文', '回归', '布局', '可访问性', '超长标签'],
  } as const;
  installApp(
    defineComponent({
      setup() {
        fixtureApi.setSidebarFontSize = async (size) => {
          sidebarSize.value = size;
          await nextTick();
          await waitForRender();
        };
        return () =>
          h(
            'section',
            { class: 'qa-grid', style: { padding: '12px', display: 'grid', gap: '12px' } },
            [
              h(
                'section',
                {
                  id: 'sidebar-contract',
                  'aria-label': 'Sidebar typography and virtual rows',
                  style: {
                    '--sidebar-font-size': `${sidebarSize.value}px`,
                    height: '420px',
                    minWidth: '0',
                    border: '1px solid #334155',
                  },
                },
                [
                  h(TreeView, {
                    rootNodes,
                    expandedPaths: [],
                    isLoading: false,
                    directoryName: '/workspace',
                    branchInfo: {
                      branch: longBranch,
                      ahead: 0,
                      behind: 0,
                      upstream: 'origin/main',
                    },
                  }),
                ],
              ),
              h(
                'section',
                {
                  id: 'snippet-contract',
                  'aria-label': 'CJK snippet layout',
                  style: { width: 'min(100%, 420px)', border: '1px solid #334155', padding: '8px' },
                },
                [h(SnippetCompletion, { snippet, sequence: '\\review' })],
              ),
            ],
          );
      },
    }),
  );
}
