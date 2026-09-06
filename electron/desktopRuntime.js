import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import path from 'node:path';
import { createPersistentStorage } from './persistentStorage.js';
import { createDesktopController, registerDesktopIpc } from './desktopController.js';
import { createDesktopShell } from './desktopShell.js';
import { createDesktopUpdates } from './updateService.js';

const prompts = {
  en: ['Install update?', 'Cancel', 'Continue', 'Finish running tasks first. Automatic installation closes Vis; manual installation opens the system installer.', 'The system installer will open. Installing vis_bridge stops its daemon and can interrupt tasks in ALL connected clients. Finish those tasks first.'],
  'zh-CN': ['安装更新？', '取消', '继续', '请先完成正在运行的任务。自动安装会退出 Vis；手动安装会打开系统安装器。', '将打开系统安装器。安装 vis_bridge 会停止守护进程，可能中断所有连接客户端的任务。请先完成这些任务。'],
  'zh-TW': ['安裝更新？', '取消', '繼續', '請先完成正在執行的工作。自動安裝會結束 Vis；手動安裝會開啟系統安裝程式。', '將開啟系統安裝程式。安裝 vis_bridge 會停止守護程序，可能中斷所有連線用戶端的工作。請先完成這些工作。'],
  ja: ['更新をインストールしますか？', 'キャンセル', '続行', '先にタスクを完了してください。自動更新は Vis を終了し、手動更新はシステムインストーラーを開きます。', 'システムインストーラーを開きます。vis_bridge のインストールはデーモンを停止し、接続中のすべてのクライアントのタスクを中断する可能性があります。先にタスクを完了してください。'],
  eo: ['Ĉu instali ĝisdatigon?', 'Nuligi', 'Daŭrigi', 'Unue finu la taskojn. Aŭtomata instalado fermas Vis; mana instalado malfermas la sisteman instalilon.', 'La sistema instalilo malfermiĝos. Instalado de vis_bridge haltigas ĝian demonon kaj povas interrompi taskojn de ĈIUJ konektitaj klientoj. Unue finu tiujn taskojn.'],
};

export function createDesktopRuntime({ getWindow, assertTrustedRenderer, closeLocalFiles }) {
  let controller = null;
  const send = (channel, payload) => {
    const window = getWindow();
    if (window && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  };
  const publish = () => {
    if (!controller) return;
    const state = controller.getState();
    if (state.updates.app.phase === 'error') getWindow()?.setEnabled(true);
    send('desktop-state', state);
  };
  const desktopShell = createDesktopShell({
    app, BrowserWindow, Menu, Tray, nativeImage, Notification, shell, getWindow,
    onChange: publish,
    onNotificationClick: (notification) => send('desktop-notification-click', notification),
  });
  const updates = createDesktopUpdates({
    app, shell, onChange: publish,
    async beforeInstall(component, signal) {
      const state = controller.getState();
      const [message, cancel, proceed, appDetail, bridgeDetail] = prompts[state.preferences.locale];
      const options = {
        type: 'warning', message, detail: component === 'bridge' ? bridgeDetail : appDetail,
        buttons: [cancel, proceed], defaultId: 0, cancelId: 0, noLink: true, signal,
      };
      const window = getWindow();
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      if (response !== 1 || signal.aborted) return false;
      if (component === 'app' && state.updates.app.installKind === 'automatic') {
        window?.setEnabled(false);
        try {
          await closeLocalFiles();
        } catch (error) {
          window?.setEnabled(true);
          throw error;
        }
      }
      return true;
    },
  });
  controller = createDesktopController({
    storage: createPersistentStorage(path.join(app.getPath('userData'), 'desktop-settings.json')),
    desktopShell, updates, publish,
  });
  registerDesktopIpc({ ipcMain, controller, assertTrustedRenderer });
  controller.start();
  let disposePromise = null;
  const dispose = () => {
    if (disposePromise) return disposePromise;
    desktopShell.dispose();
    disposePromise = updates.dispose();
    return disposePromise;
  };
  return { attachWindow: desktopShell.attachWindow, restore: desktopShell.restore, dispose };
}
