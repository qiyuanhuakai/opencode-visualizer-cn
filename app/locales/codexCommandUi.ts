import type { Locale } from '../i18n/types';

const en = {
  readOnly: 'Read only', readOnlyHint: 'Read files; request approval when an operation needs it.', workspaceWrite: 'Workspace write', workspaceWriteHint: 'Allow workspace changes; request approval for other operations.', fullAccess: 'Full access', fullAccessHint: 'Allow all file and network access without approval.',
  permissions: 'Permissions', permissionHint: 'Applies to the next message in this session.',
  disconnected: 'Connect to Codex to continue.', emptyModes: 'No permission modes are available.',
  selected: 'Selected', saving: 'Applying…', loading: 'Loading…', refresh: 'Refresh',
  sideTitle: 'Side conversation', sideHint: 'This temporary conversation leaves your main task running independently.',
  emptyChat: 'Ask a question in a temporary branch of this conversation.',
  prompt: 'Side conversation message', send: 'Send', close: 'Close side conversation',
  pending: 'Codex is responding…', user: 'You', assistant: 'Codex',
};
type CommandCopy = { readonly [K in keyof typeof en]: string };
export const codexCommandUi: Readonly<Record<Locale, CommandCopy>> = {
  en,
  'zh-CN': {
    readOnly: '只读', readOnlyHint: '只允许读取；需要执行操作时请求审批。', workspaceWrite: '工作区写入', workspaceWriteHint: '允许修改工作区；其他操作请求审批。', fullAccess: '完全访问', fullAccessHint: '允许任意文件和网络访问，不请求审批。',
    permissions: '权限模式', permissionHint: '下一条消息起在当前会话生效。',
    disconnected: '请连接 Codex 后继续。', emptyModes: '暂无可用权限模式。',
    selected: '已选择', saving: '正在应用…', loading: '正在加载…', refresh: '刷新',
    sideTitle: '侧聊', sideHint: '临时侧聊独立运行，主任务保持运行。',
    emptyChat: '在当前会话的临时分叉中提问。', prompt: '侧聊消息', send: '发送', close: '关闭侧聊',
    pending: 'Codex 正在回复…', user: '你', assistant: 'Codex',
  },
  'zh-TW': {
    readOnly: '唯讀', readOnlyHint: '僅允許讀取；需要執行操作時請求審批。', workspaceWrite: '工作區寫入', workspaceWriteHint: '允許修改工作區；其他操作請求審批。', fullAccess: '完整存取', fullAccessHint: '允許任意檔案和網路存取，不請求審批。',
    permissions: '權限模式', permissionHint: '下一則訊息起在目前對話生效。',
    disconnected: '請連接 Codex 後繼續。', emptyModes: '暫無可用權限模式。',
    selected: '已選擇', saving: '正在套用…', loading: '正在載入…', refresh: '重新整理',
    sideTitle: '側聊', sideHint: '臨時側聊獨立運行，主任務保持運行。',
    emptyChat: '在目前對話的臨時分叉中提問。', prompt: '側聊訊息', send: '傳送', close: '關閉側聊',
    pending: 'Codex 正在回覆…', user: '你', assistant: 'Codex',
  },
  ja: {
    readOnly: '読み取り専用', readOnlyHint: 'ファイルを読み取り、必要な操作には承認を求めます。', workspaceWrite: 'ワークスペースへの書き込み', workspaceWriteHint: 'ワークスペースの変更を許可し、その他の操作には承認を求めます。', fullAccess: 'フルアクセス', fullAccessHint: '承認なしで全ファイルとネットワークへのアクセスを許可します。',
    permissions: '権限モード', permissionHint: 'このセッションの次のメッセージから適用します。',
    disconnected: 'Codex に接続してください。', emptyModes: '利用可能な権限モードはありません。',
    selected: '選択済み', saving: '適用中…', loading: '読み込み中…', refresh: '更新',
    sideTitle: 'サイド会話', sideHint: '一時的な会話は独立して動作し、メインタスクは継続します。',
    emptyChat: 'この会話の一時的な分岐で質問します。', prompt: 'サイド会話のメッセージ', send: '送信', close: 'サイド会話を閉じる',
    pending: 'Codex が応答中…', user: 'あなた', assistant: 'Codex',
  },
  eo: {
    readOnly: 'Nur legado', readOnlyHint: 'Legu dosierojn; petu aprobon laŭbezone.', workspaceWrite: 'Laborspaca skribado', workspaceWriteHint: 'Permesu laborspacajn ŝanĝojn; petu aprobon por aliaj agoj.', fullAccess: 'Plena aliro', fullAccessHint: 'Permesu ĉiun dosieran kaj retan aliron sen aprobo.',
    permissions: 'Permesreĝimo', permissionHint: 'Validas ekde la sekva mesaĝo en ĉi tiu seanco.',
    disconnected: 'Konektiĝu al Codex por daŭrigi.', emptyModes: 'Neniuj permesreĝimoj disponeblas.',
    selected: 'Elektita', saving: 'Aplikante…', loading: 'Ŝargante…', refresh: 'Refreŝigi',
    sideTitle: 'Flanka konversacio', sideHint: 'Ĉi tiu portempa konversacio funkcias sendepende de la ĉefa tasko.',
    emptyChat: 'Demandu en portempa branĉo de ĉi tiu konversacio.', prompt: 'Flanka mesaĝo', send: 'Sendi', close: 'Fermi flankan konversacion',
    pending: 'Codex respondas…', user: 'Vi', assistant: 'Codex',
  },
};
