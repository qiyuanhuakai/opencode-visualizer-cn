import { describe, expect, it } from 'vitest';

import {
  flushRender,
  makeFiles,
  mountTreeView,
  searchFiles,
  setupTreeViewTestEnvironment,
} from './TreeView.testHarness';

setupTreeViewTestEnvironment();

describe('TreeView file experience', () => {
  it('renders distinct SVG icons for different file extensions and exact filenames', async () => {
    const tree = await mountTreeView(makeFiles(['main.ts', 'README.md', 'package.json']));

    const icons = Array.from(tree.root.querySelectorAll<HTMLElement>('.tree-file-icon svg'));
    expect(icons).toHaveLength(3);
    expect(new Set(icons.map((icon) => icon.innerHTML)).size).toBe(3);

    tree.unmount();
  });

  it('keeps a usable minimum width for file search beside a long branch name', async () => {
    const branchName = 'feature/a-very-long-branch-name-that-must-yield-space-to-search';
    const tree = await mountTreeView(makeFiles(['index.ts']), branchName);

    const search = tree.root.querySelector<HTMLElement>('.tree-file-search');
    expect(search).not.toBeNull();
    expect(search?.style.minWidth).toBe('128px');
    expect(tree.root.querySelector('.tree-branch-name')?.textContent).toBe(branchName);

    tree.unmount();
  });

  it('expands a directory-name search result by default and lets the user collapse and reopen it', async () => {
    const tree = await mountTreeView([
      {
        name: 'components',
        path: 'components',
        type: 'directory',
        children: [{ name: 'Button.vue', path: 'components/Button.vue', type: 'file' }],
      },
    ]);

    await searchFiles(tree.root, 'components');

    expect(tree.root.textContent).toContain('Button.vue');
    const toggle = tree.root.querySelector<HTMLButtonElement>('.tree-toggle');
    expect(toggle?.getAttribute('aria-label')).toBe('Collapse directory');

    toggle?.click();
    await flushRender();
    expect(tree.root.textContent).not.toContain('Button.vue');
    expect(tree.root.querySelector('.tree-toggle')?.getAttribute('aria-label')).toBe('Expand directory');

    tree.root.querySelector<HTMLButtonElement>('.tree-toggle')?.click();
    await flushRender();
    expect(tree.root.textContent).toContain('Button.vue');

    tree.unmount();
  });
});
