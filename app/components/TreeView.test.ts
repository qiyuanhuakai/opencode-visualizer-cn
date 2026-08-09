import { describe, expect, it } from 'vitest';

import {
  flushRender,
  makeFiles,
  mountTreeView,
  setupTreeViewTestEnvironment,
} from './TreeView.testHarness';

setupTreeViewTestEnvironment();

describe('TreeView', () => {
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
