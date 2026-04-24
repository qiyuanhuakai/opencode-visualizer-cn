const { contextBridge, ipcRenderer } = require('electron');

ipcRenderer.on('persistent-storage-changed', (_event, change) => {
  if (!change || typeof change.key !== 'string') {
    return;
  }

  window.dispatchEvent(new StorageEvent('storage', {
    key: change.key,
    oldValue: typeof change.oldValue === 'string' ? change.oldValue : null,
    newValue: typeof change.newValue === 'string' ? change.newValue : null,
    url: window.location.href,
  }));
});

/**
 * 通过 contextBridge 安全地向渲染进程暴露 API
 * 遵循 Electron 安全最佳实践：
 * - 不暴露完整的 ipcRenderer
 * - 只暴露白名单中的特定方法
 * - 所有通信经过验证
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // 平台信息
  platform: process.platform,

  // 版本信息
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },

  // 应用版本
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // 平台查询
  getPlatform: () => ipcRenderer.invoke('get-platform'),

  // 剪贴板
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  },

  persistentStorage: {
    getItem: (key) => ipcRenderer.sendSync('persistent-storage-get', key),
    setItem: (key, value) => ipcRenderer.sendSync('persistent-storage-set', { key, value }),
    removeItem: (key) => ipcRenderer.sendSync('persistent-storage-remove', key),
  },
});

