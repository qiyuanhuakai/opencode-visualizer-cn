import type { Locale } from '../i18n/types';

export interface DesktopSettingsMessages {
  pageTitle: string;
  pageDescription: string;
  linkLabel: string;
  linkDescription: string;
  loading: string;
  loadError: string;
  retry: string;
  sections: {
    updates: string;
    tray: string;
    notifications: string;
  };
  updates: {
    components: {
      app: string;
      bridge: string;
    };
    currentVersion: string;
    availableVersion: string;
    availableLocalVersion: string;
    unknownVersion: string;
    connectedBridge: {
      label: string;
      notConnected: string;
      loading: string;
      unavailable: string;
      error: string;
    };
    installKind: {
      automatic: string;
      manual: string;
      remote: string;
      unsupported: string;
    };
    status: {
      idle: string;
      checking: string;
      available: string;
      downloading: string;
      downloaded: string;
      installing: string;
      installerOpened: string;
      upToDate: string;
      error: string;
      unsupported: string;
    };
    actions: {
      check: string;
      checking: string;
      download: string;
      downloading: string;
      installRestart: string;
      openInstaller: string;
      installing: string;
      retry: string;
    };
    progressLabel: string;
    manualInstallerOpenedNotice: string;
    bridgeInterruptNotice: string;
    remoteUpdateUnavailableNotice: string;
    unsupportedNotice: string;
  };
  preferences: {
    minimizeToTray: { label: string; description: string };
    closeToTray: { label: string; description: string };
    autoCheckUpdates: { label: string; description: string };
    autoDownloadUpdates: { label: string; description: string };
    idleNotifications: { label: string; description: string };
    notificationSound: { label: string; description: string };
    trayUnavailable: string;
    notificationsUnavailable: string;
  };
}

const en: DesktopSettingsMessages = {
  pageTitle: 'Desktop',
  pageDescription: 'Native desktop integration: app and bridge updates, system tray, notifications.',
  linkLabel: 'Desktop',
  linkDescription: 'App updates, system tray behavior, and native notifications',
  loading: 'Loading desktop settings...',
  loadError: 'Desktop settings could not be loaded.',
  retry: 'Retry',
  sections: {
    updates: 'Updates',
    tray: 'System tray',
    notifications: 'Notifications',
  },
  updates: {
    components: {
      app: 'App',
      bridge: 'Bridge (vis_bridge)',
    },
    currentVersion: 'Current: {version}',
    availableVersion: 'Available: {version}',
    availableLocalVersion: 'Local installer available: {version}',
    unknownVersion: 'Unknown',
    connectedBridge: {
      label: 'Connected version',
      notConnected: 'Not connected',
      loading: 'Checking...',
      unavailable: 'Unavailable (bridge does not report a version)',
      error: 'Version check failed',
    },
    installKind: {
      automatic: 'Automatic',
      manual: 'Manual',
      remote: 'Remote',
      unsupported: 'Unsupported',
    },
    status: {
      idle: 'Idle',
      checking: 'Checking...',
      available: 'Update available',
      downloading: 'Downloading...',
      downloaded: 'Ready to install',
      installing: 'Installing...',
      installerOpened: 'Installer opened',
      upToDate: 'Up to date',
      error: 'Error',
      unsupported: 'Not supported',
    },
    actions: {
      check: 'Check for updates',
      checking: 'Checking...',
      download: 'Download',
      downloading: 'Downloading...',
      installRestart: 'Install & Restart',
      openInstaller: 'Open Installer',
      installing: 'Installing...',
      retry: 'Retry',
    },
    progressLabel: 'Download progress',
    manualInstallerOpenedNotice:
      'The installer has opened. The update is not installed yet; complete the steps in the installer window.',
    bridgeInterruptNotice:
      'Installing the bridge update restarts the local vis_bridge daemon; active Codex and ACP connections are briefly interrupted.',
    remoteUpdateUnavailableNotice:
      'This bridge is remote. Update vis_bridge on the machine where it is running.',
    unsupportedNotice: 'Updates are not supported in this build.',
  },
  preferences: {
    minimizeToTray: {
      label: 'Minimize to tray',
      description: 'Keep the app running in the system tray when the window is minimized.',
    },
    closeToTray: {
      label: 'Close to tray',
      description: 'Keep the app running in the system tray when the window is closed.',
    },
    autoCheckUpdates: {
      label: 'Automatically check for updates',
      description: 'Check for app and bridge updates in the background.',
    },
    autoDownloadUpdates: {
      label: 'Automatically download updates',
      description: 'Download available updates in the background; you still confirm installation.',
    },
    idleNotifications: {
      label: 'Idle notifications',
      description: 'Show a native notification when an agent session becomes idle.',
    },
    notificationSound: {
      label: 'Notification sound',
      description: 'Play a sound with native notifications.',
    },
    trayUnavailable: 'The system tray is not available in this desktop session.',
    notificationsUnavailable: 'Native notifications are not available on this platform.',
  },
};

const zhCN: DesktopSettingsMessages = {
  pageTitle: '桌面',
  pageDescription: '原生桌面集成：应用与 Bridge 更新、系统托盘和通知。',
  linkLabel: '桌面',
  linkDescription: '应用更新、系统托盘行为与原生通知',
  loading: '正在加载桌面设置...',
  loadError: '无法加载桌面设置。',
  retry: '重试',
  sections: {
    updates: '更新',
    tray: '系统托盘',
    notifications: '通知',
  },
  updates: {
    components: {
      app: '应用',
      bridge: '桥接器（vis_bridge）',
    },
    currentVersion: '当前版本：{version}',
    availableVersion: '可用版本：{version}',
    availableLocalVersion: '本机安装包可用版本：{version}',
    unknownVersion: '未知',
    connectedBridge: {
      label: '已连接版本',
      notConnected: '未连接',
      loading: '正在检查...',
      unavailable: '不可用（Bridge 未报告版本）',
      error: '版本检查失败',
    },
    installKind: {
      automatic: '自动',
      manual: '手动',
      remote: '远程',
      unsupported: '不支持',
    },
    status: {
      idle: '空闲',
      checking: '正在检查...',
      available: '有可用更新',
      downloading: '正在下载...',
      downloaded: '待安装',
      installing: '正在安装...',
      installerOpened: '安装程序已打开',
      upToDate: '已是最新',
      error: '错误',
      unsupported: '不支持',
    },
    actions: {
      check: '检查更新',
      checking: '正在检查...',
      download: '下载',
      downloading: '正在下载...',
      installRestart: '安装并重启',
      openInstaller: '打开安装程序',
      installing: '正在安装...',
      retry: '重试',
    },
    progressLabel: '下载进度',
    manualInstallerOpenedNotice:
      '安装程序已打开。更新尚未安装；请在安装程序窗口中完成剩余步骤。',
    bridgeInterruptNotice:
      '安装 Bridge 更新会重启本地 vis_bridge 守护进程，进行中的 Codex 与 ACP 连接会被短暂中断。',
    remoteUpdateUnavailableNotice:
      '此 Bridge 运行在远程主机上，请在运行它的主机上更新 vis_bridge。',
    unsupportedNotice: '当前构建不支持更新。',
  },
  preferences: {
    minimizeToTray: {
      label: '最小化到托盘',
      description: '最小化窗口时让应用继续在系统托盘中运行。',
    },
    closeToTray: {
      label: '关闭到托盘',
      description: '关闭窗口时让应用继续在系统托盘中运行。',
    },
    autoCheckUpdates: {
      label: '自动检查更新',
      description: '在后台检查应用与 Bridge 更新。',
    },
    autoDownloadUpdates: {
      label: '自动下载更新',
      description: '在后台下载可用更新；安装仍需你确认。',
    },
    idleNotifications: {
      label: '空闲通知',
      description: '当代理会话变为空闲时显示原生通知。',
    },
    notificationSound: {
      label: '通知声音',
      description: '显示原生通知时播放提示音。',
    },
    trayUnavailable: '当前桌面会话中系统托盘不可用。',
    notificationsUnavailable: '当前平台不支持原生通知。',
  },
};

const zhTW: DesktopSettingsMessages = {
  pageTitle: '桌面',
  pageDescription: '原生桌面整合：應用程式與橋接器更新、系統匣和通知。',
  linkLabel: '桌面',
  linkDescription: '應用程式更新、系統匣行為與原生通知',
  loading: '正在載入桌面設定...',
  loadError: '無法載入桌面設定。',
  retry: '重試',
  sections: {
    updates: '更新',
    tray: '系統匣',
    notifications: '通知',
  },
  updates: {
    components: {
      app: '應用程式',
      bridge: '橋接器（vis_bridge）',
    },
    currentVersion: '目前版本：{version}',
    availableVersion: '可用版本：{version}',
    availableLocalVersion: '本機安裝程式可用版本：{version}',
    unknownVersion: '未知',
    connectedBridge: {
      label: '已連線版本',
      notConnected: '未連線',
      loading: '正在檢查...',
      unavailable: '不可用（橋接器未回報版本）',
      error: '版本檢查失敗',
    },
    installKind: {
      automatic: '自動',
      manual: '手動',
      remote: '遠端',
      unsupported: '不支援',
    },
    status: {
      idle: '閒置',
      checking: '正在檢查...',
      available: '有可用更新',
      downloading: '正在下載...',
      downloaded: '待安裝',
      installing: '正在安裝...',
      installerOpened: '安裝程式已開啟',
      upToDate: '已是最新',
      error: '錯誤',
      unsupported: '不支援',
    },
    actions: {
      check: '檢查更新',
      checking: '正在檢查...',
      download: '下載',
      downloading: '正在下載...',
      installRestart: '安裝並重新啟動',
      openInstaller: '開啟安裝程式',
      installing: '正在安裝...',
      retry: '重試',
    },
    progressLabel: '下載進度',
    manualInstallerOpenedNotice:
      '安裝程式已開啟。更新尚未安裝；請在安裝程式視窗中完成剩餘步驟。',
    bridgeInterruptNotice:
      '安裝橋接器更新會重新啟動本機 vis_bridge 守護行程，進行中的 Codex 與 ACP 連線會短暫中斷。',
    remoteUpdateUnavailableNotice: '此橋接器在遠端主機上執行，請在執行它的主機上更新 vis_bridge。',
    unsupportedNotice: '此版本不支援更新。',
  },
  preferences: {
    minimizeToTray: {
      label: '最小化到系統匣',
      description: '最小化視窗時讓應用程式繼續在系統匣中執行。',
    },
    closeToTray: {
      label: '關閉到系統匣',
      description: '關閉視窗時讓應用程式繼續在系統匣中執行。',
    },
    autoCheckUpdates: {
      label: '自動檢查更新',
      description: '在背景檢查應用程式與橋接器更新。',
    },
    autoDownloadUpdates: {
      label: '自動下載更新',
      description: '在背景下載可用更新；安裝仍需你確認。',
    },
    idleNotifications: {
      label: '閒置通知',
      description: '當代理工作階段閒置時顯示原生通知。',
    },
    notificationSound: {
      label: '通知音效',
      description: '顯示原生通知時播放提示音。',
    },
    trayUnavailable: '此桌面工作階段無法使用系統匣。',
    notificationsUnavailable: '此平台不支援原生通知。',
  },
};

const ja: DesktopSettingsMessages = {
  pageTitle: 'デスクトップ',
  pageDescription: 'ネイティブデスクトップ統合：アプリとブリッジの更新、システムトレイ、通知。',
  linkLabel: 'デスクトップ',
  linkDescription: 'アプリの更新、システムトレイの動作、ネイティブ通知',
  loading: 'デスクトップ設定を読み込み中...',
  loadError: 'デスクトップ設定を読み込めませんでした。',
  retry: '再試行',
  sections: {
    updates: '更新',
    tray: 'システムトレイ',
    notifications: '通知',
  },
  updates: {
    components: {
      app: 'アプリ',
      bridge: 'ブリッジ（vis_bridge）',
    },
    currentVersion: '現在のバージョン: {version}',
    availableVersion: '利用可能なバージョン: {version}',
    availableLocalVersion: 'ローカルインストーラー: {version}',
    unknownVersion: '不明',
    connectedBridge: {
      label: '接続中のバージョン',
      notConnected: '未接続',
      loading: '確認中...',
      unavailable: '利用不可（ブリッジがバージョンを報告しません）',
      error: 'バージョン確認に失敗しました',
    },
    installKind: {
      automatic: '自動',
      manual: '手動',
      remote: 'リモート',
      unsupported: '非対応',
    },
    status: {
      idle: '待機中',
      checking: '確認中...',
      available: '更新があります',
      downloading: 'ダウンロード中...',
      downloaded: 'インストール可能',
      installing: 'インストール中...',
      installerOpened: 'インストーラーを開きました',
      upToDate: '最新です',
      error: 'エラー',
      unsupported: '非対応',
    },
    actions: {
      check: '更新を確認',
      checking: '確認中...',
      download: 'ダウンロード',
      downloading: 'ダウンロード中...',
      installRestart: 'インストールして再起動',
      openInstaller: 'インストーラーを開く',
      installing: 'インストール中...',
      retry: '再試行',
    },
    progressLabel: 'ダウンロード進捗',
    manualInstallerOpenedNotice:
      'インストーラーが開きました。更新はまだインストールされていません。インストーラーウィンドウで手順を完了してください。',
    bridgeInterruptNotice:
      'ブリッジの更新をインストールするとローカルの vis_bridge デーモンが再起動し、実行中の Codex および ACP 接続が一時的に中断されます。',
    remoteUpdateUnavailableNotice:
      'このブリッジはリモートで実行されています。実行先のマシンで vis_bridge を更新してください。',
    unsupportedNotice: 'このビルドでは更新はサポートされていません。',
  },
  preferences: {
    minimizeToTray: {
      label: 'トレイに最小化',
      description: 'ウィンドウを最小化してもアプリをシステムトレイで実行し続けます。',
    },
    closeToTray: {
      label: 'トレイに閉じる',
      description: 'ウィンドウを閉じてもアプリをシステムトレイで実行し続けます。',
    },
    autoCheckUpdates: {
      label: '更新を自動確認',
      description: 'アプリとブリッジの更新をバックグラウンドで確認します。',
    },
    autoDownloadUpdates: {
      label: '更新を自動ダウンロード',
      description:
        '利用可能な更新をバックグラウンドでダウンロードします。インストールは手動で確認します。',
    },
    idleNotifications: {
      label: 'アイドル通知',
      description: 'エージェントセッションがアイドルになったときにネイティブ通知を表示します。',
    },
    notificationSound: {
      label: '通知音',
      description: 'ネイティブ通知で音を再生します。',
    },
    trayUnavailable: 'このデスクトップセッションではシステムトレイを利用できません。',
    notificationsUnavailable: 'このプラットフォームではネイティブ通知を利用できません。',
  },
};

const eo: DesktopSettingsMessages = {
  pageTitle: 'Labortablo',
  pageDescription: 'Denaska labortabla integriĝo: ĝisdatigoj de aplikaĵo kaj ponto, sistemopletto, sciigoj.',
  linkLabel: 'Labortablo',
  linkDescription: 'Ĝisdatigoj, konduto de sistemopletto kaj denaskaj sciigoj',
  loading: 'Ŝargas labortablajn agordojn...',
  loadError: 'Ne eblis ŝargi la labortablajn agordojn.',
  retry: 'Reprovi',
  sections: {
    updates: 'Ĝisdatigoj',
    tray: 'Sistemopletto',
    notifications: 'Sciigoj',
  },
  updates: {
    components: {
      app: 'Aplikaĵo',
      bridge: 'Ponto (vis_bridge)',
    },
    currentVersion: 'Nuna versio: {version}',
    availableVersion: 'Havebla versio: {version}',
    availableLocalVersion: 'Loka instalilo havebla: {version}',
    unknownVersion: 'Nekonata',
    connectedBridge: {
      label: 'Konektita versio',
      notConnected: 'Ne konektita',
      loading: 'Kontrolas...',
      unavailable: 'Ne havebla (la ponto ne raportas version)',
      error: 'Versikontrolo malsukcesis',
    },
    installKind: {
      automatic: 'Aŭtomata',
      manual: 'Mana',
      remote: 'Fora',
      unsupported: 'Nesubtenata',
    },
    status: {
      idle: 'Senokupa',
      checking: 'Kontrolas...',
      available: 'Ĝisdatigo havebla',
      downloading: 'Elŝutas...',
      downloaded: 'Preta por instalado',
      installing: 'Instalas...',
      installerOpened: 'Instalilo malfermita',
      upToDate: 'Ĝisdata',
      error: 'Eraro',
      unsupported: 'Nesubtenata',
    },
    actions: {
      check: 'Kontroli ĝisdatigojn',
      checking: 'Kontrolas...',
      download: 'Elŝuti',
      downloading: 'Elŝutas...',
      installRestart: 'Instali kaj relanĉi',
      openInstaller: 'Malfermi instalilon',
      installing: 'Instalas...',
      retry: 'Reprovi',
    },
    progressLabel: 'Elŝuta progreso',
    manualInstallerOpenedNotice:
      'La instalilo malfermiĝis. La ĝisdatigo ankoraŭ ne estas instalita; finu la paŝojn en la instalila fenestro.',
    bridgeInterruptNotice:
      'Instalado de la ponta ĝisdatigo relanĉas la lokan vis_bridge-daemonon; aktivaj Codex- kaj ACP-konektoj estas mallonge interrompitaj.',
    remoteUpdateUnavailableNotice:
      'Ĉi tiu ponto estas fora. Ĝisdatigu vis_bridge sur la maŝino, kie ĝi funkcias.',
    unsupportedNotice: 'Ĝisdatigoj ne estas subtenataj en ĉi tiu konstruaĵo.',
  },
  preferences: {
    minimizeToTray: {
      label: 'Minimumigi al pletto',
      description: 'Tenas la aplikaĵon aktiva en la sistemopletto kiam la fenestro estas minimumigita.',
    },
    closeToTray: {
      label: 'Fermi al pletto',
      description: 'Tenas la aplikaĵon aktiva en la sistemopletto kiam la fenestro estas fermita.',
    },
    autoCheckUpdates: {
      label: 'Aŭtomate kontroli ĝisdatigojn',
      description: 'Kontrolas aplikaĵajn kaj pontajn ĝisdatigojn en la fono.',
    },
    autoDownloadUpdates: {
      label: 'Aŭtomate elŝuti ĝisdatigojn',
      description: 'Elŝutas haveblajn ĝisdatigojn en la fono; instalado ankoraŭ bezonas vian konfirmon.',
    },
    idleNotifications: {
      label: 'Senokupaj sciigoj',
      description: 'Montras denaskan sciigon kiam agenta seanco senokupiĝas.',
    },
    notificationSound: {
      label: 'Sciiga sono',
      description: 'Ludas sonon kun denaskaj sciigoj.',
    },
    trayUnavailable: 'La sistemopletto ne estas havebla en ĉi tiu labortabla seanco.',
    notificationsUnavailable: 'Denaskaj sciigoj ne estas haveblaj sur ĉi tiu platformo.',
  },
};

export const desktopMessages: Record<Locale, { desktopSettings: DesktopSettingsMessages }> = {
  en: { desktopSettings: en },
  'zh-CN': { desktopSettings: zhCN },
  'zh-TW': { desktopSettings: zhTW },
  ja: { desktopSettings: ja },
  eo: { desktopSettings: eo },
};
