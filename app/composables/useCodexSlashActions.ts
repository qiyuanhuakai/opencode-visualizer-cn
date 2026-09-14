import type { Ref } from 'vue';
import type { useCodexApi } from './useCodexApi';
import type { ParsedCodexSlashCommand } from '../utils/codexSlashCommands';
import initPrompt from '../assets/codex/prompt_for_init_command.md?raw';

type MonitorTab = 'server' | 'token' | 'codex' | 'skills' | 'mcp' | 'plugins';
type Api = ReturnType<typeof useCodexApi>;
type Actions = {
  readonly api: Api;
  readonly locale: Ref<string>;
  readonly messageInput: Ref<string>;
  readonly selectedSessionId: Ref<string>;
  readonly selectedModel: Ref<string>;
  readonly selectedMode: Ref<string>;
  readonly openMonitor: (tab: MonitorTab, view?: 'daily' | 'weekly' | 'cumulative') => void;
  readonly openModel: () => void;
  readonly openPermissions: () => void;
  readonly openSide: () => void;
  readonly openGoal: () => void;
  readonly openSessions: () => void;
  readonly openTerminals: () => void;
  readonly openDiff: () => Promise<void>;
  readonly createSession: () => Promise<{ id: string } | undefined>;
  readonly renameSession: (id: string) => Promise<void>;
  readonly selectSession: (id: string) => Promise<void>;
  readonly selectMode: (mode: string) => void;
};

class SlashActionError extends Error {
  override readonly name = 'SlashActionError';
}

export function useCodexSlashActions(actions: Actions) {
  const { api } = actions;
  const text = (zh: string, en: string) => actions.locale.value.startsWith('zh') ? zh : en;
  const requireThread = () => {
    const id = actions.selectedSessionId.value;
    if (!id || api.activeThreadId.value !== id) {
      throw new SlashActionError(text('请先选择并加载 Codex 会话。', 'Select and load a Codex thread first.'));
    }
    return id;
  };
  const requireIdle = () => {
    if (api.pending.value || api.activeTurn.value?.status === 'inProgress') {
      throw new SlashActionError(text('当前任务运行中，请结束后再执行此命令。', 'Wait for the current turn to finish.'));
    }
  };
  const noArguments = (command: ParsedCodexSlashCommand) => {
    if (command.arguments) throw new SlashActionError(`/${command.name}`);
  };

  async function goal(argument: string) {
    requireThread();
    switch (argument) {
      case '': case 'edit': actions.openGoal(); return;
      case 'clear': await api.clearThreadGoal(); return;
      case 'pause': await api.setThreadGoal({ status: 'paused' }); return;
      case 'resume': await api.setThreadGoal({ status: 'active' }); return;
      default: await api.setThreadGoal({ objective: argument }); actions.openGoal();
    }
  }

  async function execute(command: ParsedCodexSlashCommand): Promise<'handled' | 'not-handled'> {
    const argument = command.arguments.trim();
    switch (command.name) {
      case 'status': noArguments(command); actions.openMonitor('server'); return 'handled';
      case 'usage':
        if (!['', 'daily', 'weekly', 'cumulative'].includes(argument)) {
          throw new SlashActionError('/usage [daily|weekly|cumulative]');
        }
        actions.openMonitor('token', argument === 'daily' || argument === 'weekly' ? argument : 'cumulative');
        return 'handled';
      case 'skills': case 'mcp': case 'plugins':
        noArguments(command); actions.openMonitor(command.name); return 'handled';
      case 'model': noArguments(command); actions.openModel(); return 'handled';
      case 'resume': noArguments(command); actions.openSessions(); return 'handled';
      default: break;
    }
    if (!api.connected.value) throw new SlashActionError(text('Codex 尚未连接。', 'Codex is disconnected.'));
    if (['fast', 'btw', 'side'].includes(command.name) && actions.selectedModel.value) {
      api.selectModel(actions.selectedModel.value);
    }
    switch (command.name) {
      case 'fast': {
        if (!['', 'on', 'off'].includes(argument)) throw new SlashActionError('/fast [on|off]');
        await api.setFastMode(argument ? argument === 'on' : api.selectedServiceTier.value === 'default');
        break;
      }
      case 'permissions':
        if (argument) await api.setPermissionMode(argument);
        else actions.openPermissions();
        break;
      case 'init':
        noArguments(command); requireIdle();
        if (!actions.selectedSessionId.value && !await actions.createSession()) {
          throw new SlashActionError(text('无法创建会话。', 'Could not create a thread.'));
        }
        actions.messageInput.value = initPrompt;
        return 'not-handled';
      case 'plan':
        if (!argument && actions.selectedMode.value === 'plan') {
          actions.selectMode('default');
          break;
        }
        if (argument) requireIdle();
        if (!api.collaborationModes.value.some((mode) => mode.mode === 'plan')) {
          throw new SlashActionError(text('当前服务器未提供 Plan 模式。', 'This server does not offer Plan mode.'));
        }
        actions.selectMode('plan');
        if (argument) {
          if (!actions.selectedSessionId.value && !await actions.createSession()) {
            throw new SlashActionError(text('无法创建会话。', 'Could not create a thread.'));
          }
          actions.messageInput.value = command.arguments;
          return 'not-handled';
        }
        break;
      case 'goal': await goal(argument); break;
      case 'compact': noArguments(command); requireIdle(); await api.startThreadCompaction(requireThread()); break;
      case 'new': {
        const thread = await actions.createSession();
        if (!thread) throw new SlashActionError(text('无法创建会话。', 'Could not create a thread.'));
        if (argument) await api.setThreadName(thread.id, argument);
        break;
      }
      case 'fork': {
        noArguments(command);
        const thread = await api.forkThread(requireThread());
        await actions.selectSession(thread.id);
        break;
      }
      case 'btw': case 'side':
        requireThread();
        await api.startSideChat(argument);
        actions.openSide();
        break;
      case 'rename': {
        const id = requireThread();
        if (argument) await api.setThreadName(id, argument);
        else await actions.renameSession(id);
        break;
      }
      case 'archive':
        noArguments(command);
        await api.archiveThread(requireThread());
        await actions.selectSession(api.activeThreadId.value);
        break;
      case 'diff': noArguments(command); await actions.openDiff(); break;
      case 'review':
        requireThread(); requireIdle();
        await api.reviewThread(argument ? { type: 'custom', instructions: argument } : { type: 'uncommittedChanges' });
        break;
      case 'ps': noArguments(command); requireThread(); actions.openTerminals(); break;
      case 'stop': noArguments(command); await api.cleanThreadBackgroundTerminals(requireThread()); break;
      case 'copy': {
        noArguments(command); requireThread();
        const history = [...api.canonicalHistory.value, ...api.realtimeHistoryQueue.value];
        const last = history.reverse().find((entry) => entry.info.role === 'assistant' && entry.info.time.completed);
        const content = last?.parts.filter((part) => part.type === 'text').map((part) => part.type === 'text' ? part.text : '').join('\n');
        if (!content) throw new SlashActionError(text('尚无已完成的回复。', 'No completed response to copy.'));
        await navigator.clipboard.writeText(content);
        break;
      }
      default: throw new SlashActionError(`/${command.name}`);
    }
    return 'handled';
  }
  return { execute };
}
