const LABELS = Object.freeze({
  en: Object.freeze({
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    restore: 'Restore',
    quit: 'Quit',
  }),
  'zh-CN': Object.freeze({
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    restore: '恢复',
    quit: '退出',
  }),
  'zh-TW': Object.freeze({
    edit: '編輯',
    undo: '復原',
    redo: '重做',
    cut: '剪下',
    copy: '複製',
    paste: '貼上',
    selectAll: '全選',
    restore: '恢復',
    quit: '結束',
  }),
  ja: Object.freeze({
    edit: '編集',
    undo: '元に戻す',
    redo: 'やり直す',
    cut: '切り取り',
    copy: 'コピー',
    paste: '貼り付け',
    selectAll: 'すべて選択',
    restore: '表示',
    quit: '終了',
  }),
  eo: Object.freeze({
    edit: 'Redakti',
    undo: 'Malfari',
    redo: 'Refari',
    cut: 'Eltondi',
    copy: 'Kopii',
    paste: 'Alglui',
    selectAll: 'Elekti ĉion',
    restore: 'Restarigi',
    quit: 'Ĉesi',
  }),
});

export function getDesktopShellLabels(locale) {
  return LABELS[locale] ?? LABELS.en;
}

export function createApplicationMenuTemplate(appName, labels) {
  return [
    {
      label: appName,
      submenu: [
        {
          label: labels.quit,
          role: 'quit',
        },
      ],
    },
    {
      label: labels.edit,
      submenu: [
        { label: labels.undo, role: 'undo' },
        { label: labels.redo, role: 'redo' },
        { type: 'separator' },
        { label: labels.cut, role: 'cut' },
        { label: labels.copy, role: 'copy' },
        { label: labels.paste, role: 'paste' },
        { type: 'separator' },
        { label: labels.selectAll, role: 'selectAll' },
      ],
    },
  ];
}

export function createTrayMenuTemplate(labels, restore) {
  return [
    { label: labels.restore, click: restore },
    { label: labels.quit, role: 'quit' },
  ];
}
