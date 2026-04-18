const { contextBridge, ipcRenderer } = require('electron');

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
});

// 开发模式下输出日志
if (process.env.NODE_ENV === 'development') {
  console.log('[Preload] Electron API exposed to renderer');
}
