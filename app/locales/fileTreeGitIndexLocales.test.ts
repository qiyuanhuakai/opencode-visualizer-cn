import { describe, expect, it } from 'vitest';

import en from './en';
import eo from './eo';
import ja from './ja';
import zhCN from './zh-CN';
import zhTW from './zh-TW';

describe('file tree Git index terminology', () => {
  it('distinguishes the index view from git stash in every locale', () => {
    expect(en.treeView.staged).toBe('Index');
    expect(zhCN.treeView.staged).toBe('索引区');
    expect(zhTW.treeView.staged).toBe('索引區');
    expect(ja.treeView.staged).toBe('インデックス');
    expect(eo.treeView.staged).toBe('Indekso');
  });
});
