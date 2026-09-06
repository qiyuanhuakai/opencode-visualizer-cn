const LABELS = Object.freeze({
  en: Object.freeze({
    reload: 'Reload',
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
    reload: '刷新',
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
    reload: '重新載入',
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
    reload: '再読み込み',
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
    reload: 'Reŝargi',
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
      label: labels.reload,
      submenu: [
        { label: labels.reload, role: 'reload', accelerator: 'CmdOrCtrl+R' },
        ...['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].map((role) => ({
          label: labels[role], role, visible: false, acceleratorWorksWhenHidden: true,
        })),
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
