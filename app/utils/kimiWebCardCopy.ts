export function kimiWebCardCopy(locale: string) {
  if (locale.startsWith('zh')) return {
    fork: '从此消息之前创建分支？仅复制之前的会话上下文，此消息将放入输入框。磁盘文件不会回退。',
    undo: '撤销此消息及之后的会话上下文？磁盘文件不会回退，此操作无法重做，也不能跨越压缩点。',
    empty: '此轮没有文件差异。', loading: '正在读取此轮文件差异…',
  };
  return {
    fork: 'Create a branch before this message? Earlier conversation context is copied and this prompt is placed in the composer. Files on disk are not rolled back.',
    undo: 'Remove this message and all later conversation context? Files on disk are not rolled back. This cannot be redone or cross a compaction checkpoint.',
    empty: 'No file changes in this turn.', loading: 'Loading file changes for this turn…',
  };
}
