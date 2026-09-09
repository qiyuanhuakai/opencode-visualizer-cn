import type { Locale } from '../i18n/types';

const en = {
  setGoal: 'Set thread goal',
  help: 'A thread goal guides continued work. Saving does not start a turn.',
  budgetHelp: 'Optional. Leave blank for no token budget; otherwise enter a positive whole number.',
  disconnected: 'Connect to Codex to manage a goal.',
  noThread: 'Select or create a thread to manage its goal.',
  loading: 'Loading this thread’s goal…',
  unsupported: 'This Codex version does not support this goal operation.',
  gated: 'This goal operation is unavailable in the current Codex configuration.',
  loadError: 'Could not load the goal. Refresh to retry.',
  empty: 'No goal is set for this thread.',
  invalidBudget: 'Enter a positive whole number, or leave the budget blank.',
  tooLong: 'The objective must contain at most 4,000 characters.',
  saved: 'Goal saved.', cleared: 'Goal cleared.', failed: 'The goal could not be updated. Try again.',
  saving: 'Saving…', clearing: 'Clearing…', tokensUsed: 'Goal tokens used', timeUsed: 'Goal time used (seconds)',
};
type GoalCopy = { readonly [K in keyof typeof en]: string };
export const codexGoalUi: Readonly<Record<Locale, GoalCopy>> = {
  en,
  'zh-CN': {
    setGoal: '设置线程目标',
    help: '引导线程持续工作；保存目标不会开始执行。', budgetHelp: '可选：留空不设预算，填写时仅接受正整数。',
    disconnected: '请连接 Codex 后管理目标。', noThread: '请选择或创建线程后管理目标。', loading: '正在读取此线程的目标…',
    unsupported: '当前 Codex 版本不支持此目标操作。', gated: '当前 Codex 配置未开放此目标操作。', loadError: '读取目标失败，请刷新重试。',
    empty: '此线程尚未设置目标。', invalidBudget: '预算请输入正整数，或留空。', tooLong: '目标最多可输入 4,000 个字符。',
    saved: '目标已保存。', cleared: '目标已清除。', failed: '更新目标失败，请重试。', saving: '正在保存…', clearing: '正在清除…', tokensUsed: '目标已用 token', timeUsed: '目标已用时间（秒）',
  },
  'zh-TW': {
    setGoal: '設定執行緒目標',
    help: '引導執行緒持續工作；儲存目標不會開始執行。', budgetHelp: '選填：留空不設預算，填寫時僅接受正整數。',
    disconnected: '請連線 Codex 後管理目標。', noThread: '請選取或建立執行緒後管理目標。', loading: '正在讀取此執行緒的目標…',
    unsupported: '目前 Codex 版本不支援此目標操作。', gated: '目前 Codex 設定未開放此目標操作。', loadError: '讀取目標失敗，請重新整理後重試。',
    empty: '此執行緒尚未設定目標。', invalidBudget: '預算請輸入正整數，或留空。', tooLong: '目標最多可輸入 4,000 個字元。',
    saved: '目標已儲存。', cleared: '目標已清除。', failed: '更新目標失敗，請重試。', saving: '正在儲存…', clearing: '正在清除…', tokensUsed: '目標已用 token', timeUsed: '目標已用時間（秒）',
  },
  ja: {
    setGoal: 'スレッド目標を設定',
    help: 'スレッド目標は継続作業の指針です。保存してもターンは開始しません。', budgetHelp: '任意。空欄はトークン予算なし。設定する場合は正の整数を入力してください。',
    disconnected: '目標を管理するには Codex に接続してください。', noThread: 'スレッドを選択または作成してください。', loading: '目標を読み込み中…',
    unsupported: 'この Codex バージョンはこの目標操作に対応していません。', gated: '現在の Codex 設定ではこの目標操作を利用できません。', loadError: '目標を読み込めませんでした。更新して再試行してください。',
    empty: 'このスレッドには目標がありません。', invalidBudget: '正の整数を入力するか、空欄にしてください。', tooLong: '目標は 4,000 文字以内にしてください。',
    saved: '目標を保存しました。', cleared: '目標を削除しました。', failed: '目標を更新できませんでした。再試行してください。', saving: '保存中…', clearing: '削除中…', tokensUsed: '目標の使用トークン', timeUsed: '目標の使用時間（秒）',
  },
  eo: {
    setGoal: 'Agordi fadenan celon',
    help: 'Fadena celo gvidas daŭran laboron. Konservi ne komencas vicon.', budgetHelp: 'Nedeviga. Lasu malplena por neniu ĵetona buĝeto, aŭ enigu pozitivan entjeron.',
    disconnected: 'Konektu al Codex por administri celon.', noThread: 'Elektu aŭ kreu fadenon por administri ĝian celon.', loading: 'Ŝargante la celon…',
    unsupported: 'Ĉi tiu Codex-versio ne subtenas ĉi tiun celoperacion.', gated: 'Ĉi tiu celoperacio ne disponeblas en la nuna agordo.', loadError: 'Ne eblis ŝargi la celon. Aktualigu por reprovi.',
    empty: 'Neniu celo estas agordita por ĉi tiu fadeno.', invalidBudget: 'Enigu pozitivan entjeron aŭ lasu la buĝeton malplena.', tooLong: 'La celo devas enhavi maksimume 4 000 signojn.',
    saved: 'Celo konservita.', cleared: 'Celo forigita.', failed: 'Ne eblis ĝisdatigi la celon. Reprovu.', saving: 'Konservante…', clearing: 'Forigante…', tokensUsed: 'Uzitaj celĵetonoj', timeUsed: 'Uzita celtempo (sekundoj)',
  },
};
