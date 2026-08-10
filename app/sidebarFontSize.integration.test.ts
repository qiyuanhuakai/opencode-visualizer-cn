import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function expectSidebarFontRule(path: string, selector: string): void {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(source(path)).toMatch(
    new RegExp(
      `${escapedSelector}\\s*\\{[^}]*font-size:\\s*var\\(--sidebar-font-size,\\s*12px\\)`,
      's',
    ),
  );
}

describe('sidebar font size integration', () => {
  it('offers a dedicated sidebar size control and publishes its CSS variable', () => {
    const settingsModal = source('app/components/SettingsModal.vue');
    const app = source('app/App.vue');

    expect(settingsModal).toContain('settings-sidebar-font-size');
    expect(settingsModal).toContain('v-model.number="sidebarFontSizePx"');
    expect(app).toContain("'--sidebar-font-size'");
  });

  it('applies the sidebar size only to the requested sidebar text categories', () => {
    const sidePanel = source('app/components/SidePanel.vue');
    expect(sidePanel).toContain("t('sidePanel.tabs.tree')");
    expect(sidePanel).toContain("t('sidePanel.tabs.session')");
    expect(sidePanel).toContain("t('sidePanel.tabs.todo')");

    expectSidebarFontRule('app/components/SidePanel.vue', '.side-tab');
    expectSidebarFontRule('app/components/TreeView.vue', '.tree-name');
    expectSidebarFontRule('app/components/SessionTree.vue', '.session-tree-label');
    expectSidebarFontRule('app/components/TodoList.vue', '.todo-title');
    expectSidebarFontRule('app/components/TodoList.vue', '.todo-text');
  });

  it('scales file tree icons with sidebar text while preserving the virtual row height', () => {
    const treeView = source('app/components/TreeView.vue');

    expect(treeView).toContain(
      '--tree-icon-size: clamp(18px, calc(var(--sidebar-font-size, 12px) + 6px), 20px);',
    );
    expect(treeView).toMatch(/\.tree-icon\s*\{[^}]*flex:\s*0 0 var\(--tree-icon-size\)/s);
    expect(treeView).toMatch(/\.tree-icon :deep\(svg\)\s*\{[^}]*width:\s*var\(--tree-icon-size\)/s);
  });
});
