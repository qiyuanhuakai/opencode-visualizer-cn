import { useI18n } from 'vue-i18n';
import { runtimeCommonCopy } from './runtimeUiCommon';
import { runtimeArtifactCopy } from './runtimeUiArtifacts';
import { runtimeThreadCopy } from './runtimeUiThreads';
import { runtimeRemoteCopy } from './runtimeUiRemote';
import { runtimeCollaborationCopy } from './runtimeUiCollaboration';
import { runtimeStateCopy } from './runtimeUiStates';
import { runtimeFeedbackCopy } from './runtimeUiFeedback';

export const runtimeCopy = [
  ...runtimeCommonCopy, ...runtimeArtifactCopy, ...runtimeThreadCopy,
  ...runtimeRemoteCopy, ...runtimeCollaborationCopy, ...runtimeStateCopy, ...runtimeFeedbackCopy,
] as const;

export function runtimeCopyKey(message: string): string {
  return `copy_${message.replace(/[^a-zA-Z0-9]/gu, (character) => `_${character.codePointAt(0)?.toString(16)}_`)}`;
}

const copyKeys = new Map(runtimeCopy.map(([message]) => [message, runtimeCopyKey(message)]));
const bridgeCopyAliases = new Map([
  ['one writer lease per task, and at most WRITER_LIMITS.maxWritersPerRepository per repository', 'Each task has at most one writer lease. Each repository limits simultaneous writers.'],
  ['conflict: host.writer_lease', 'Check the writer lease and its Agent session before retrying.'],
  ['unauthorized: host.artifact_repository', 'Choose the repository used to allocate this writer.'],
  ['conflict: host.artifact_review', 'Approve the current artifact review first.'],
]);
function copyMessages(index: 0 | 1 | 2 | 3 | 4): Record<string, string> {
  return Object.fromEntries(runtimeCopy.map((row) => [runtimeCopyKey(row[0]), row[index]]));
}

const en = {
  ...copyMessages(0),
  member: 'Thread participant', role: 'Team role', worker: 'Worker', lead: 'Lead', addMember: 'Add member',
  taskTitle: 'Task title',
  criteria: 'Acceptance criteria (one per line)',
  createTask: 'Create task',
  verifyCriteria: 'Verify acceptance criteria',
  deliverableRequired: 'A deliverable is required before acceptance.',
  closeConnections: 'Close connection manager',
  connections: 'SSH / HPC connection',
};

export const runtimeUiMessages = {
  en,
  'zh-CN': {
    ...copyMessages(1),
    member: 'Thread 参与者', role: '团队角色', worker: '执行者', lead: '负责人', addMember: '添加成员',
    taskTitle: '任务标题',
    criteria: '验收标准（每行一项）',
    createTask: '创建任务',
    verifyCriteria: '确认验收标准',
    deliverableRequired: '提交实际交付物后才能验收。',
    closeConnections: '关闭连接管理',
    connections: 'SSH / HPC 连接',
  },
  'zh-TW': {
    ...copyMessages(2),
    member: 'Thread 參與者', role: '團隊角色', worker: '執行者', lead: '負責人', addMember: '新增成員',
    taskTitle: '任務標題',
    criteria: '驗收標準（每行一項）',
    createTask: '建立任務',
    verifyCriteria: '確認驗收標準',
    deliverableRequired: '提交實際交付物後才能驗收。',
    closeConnections: '關閉連線管理',
    connections: 'SSH / HPC 連線',
  },
  ja: {
    ...copyMessages(3),
    member: 'スレッドの参加者', role: 'チームの役割', worker: '作業者', lead: 'リーダー', addMember: 'メンバーを追加',
    taskTitle: 'タスク名',
    criteria: '受け入れ条件（1行に1項目）',
    createTask: 'タスクを作成',
    verifyCriteria: '受け入れ条件を確認',
    deliverableRequired: '受け入れには成果物の提出が必要です。',
    closeConnections: '接続管理を閉じる',
    connections: 'SSH / HPC 接続',
  },
  eo: {
    ...copyMessages(4),
    member: 'Fadena partoprenanto', role: 'Teama rolo', worker: 'Laboranto', lead: 'Gvidanto', addMember: 'Aldoni membron',
    taskTitle: 'Titolo de tasko',
    criteria: 'Akceptokriterioj (unu en ĉiu linio)',
    createTask: 'Krei taskon',
    verifyCriteria: 'Kontroli akceptokriteriojn',
    deliverableRequired: 'Necesas liveraĵo antaŭ akcepto.',
    closeConnections: 'Fermi konektan administrilon',
    connections: 'SSH / HPC konekto',
  },
};

type CopyParameters = Readonly<Record<string, string | number>>;
type CopyTranslator = (key: string, parameters: CopyParameters) => string;

export function translateRuntimeUi(message: string, translate: CopyTranslator, parameters: CopyParameters = {}): string {
  const key = copyKeys.get(bridgeCopyAliases.get(message) ?? message);
  return key === undefined ? message : translate(key, parameters);
}

export function useRuntimeUi() {
  const { t } = useI18n({ useScope: 'local', messages: runtimeUiMessages });
  return { t, rt: (message: string, parameters: CopyParameters = {}) => translateRuntimeUi(message, t, parameters) };
}
