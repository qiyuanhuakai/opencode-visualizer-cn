import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';

import ForgePanel from './ForgePanel.vue';

function createMessages() {
  return {
    en: {
      forgePanel: {
        title: 'Forge',
        description: 'Zsh-powered Forge terminal',
        promptLabel: 'Forge prompt',
        promptPlaceholder: 'Ask Forge through : prompt',
        modeSelector: 'Forge function',
        modeLabel: 'Mode',
        send: 'Send',
        hideSidebar: 'Hide sidebar',
        showSidebar: 'Show sidebar',
        auxiliaryTitle: 'Structured reads',
        conversationCommandsTitle: 'Conversation commands',
        statusLabel: 'Status',
        statusButton: 'Status',
        statusUnavailable: 'No status',
        statusPopoverTitle: 'Forge status',
        commandGroups: {
          config: 'Config',
          temporary: 'Temporary',
          workspace: 'Workspace',
          conversation: 'Conversation',
        },
        refresh: 'Refresh',
        loading: 'Loading Forge metadata…',
        emptyConversations: 'No Forge conversations found',
        errorLabel: 'Forge metadata error',
        previewTitle: 'Conversation preview',
        dump: 'Dump JSON',
        dumpTitle: 'Conversation dump',
        shortcuts: {
          forge: 'Forge',
          sage: 'Sage',
          muse: 'Muse',
          suggest: 'Suggest',
          commitPreview: 'Commit preview',
          new: 'New',
          clone: 'Clone',
          conversation: 'Conversation',
          conversationRename: 'Rename',
          conversationTree: 'Tree',
          delete: 'Delete',
          compact: 'Compact',
          copy: 'Copy',
          edit: 'Edit',
          retry: 'Retry',
          config: 'Config',
          configEdit: 'Edit config',
          configModel: 'Config model',
          configReload: 'Reload config',
          configCommitModel: 'Commit model',
          configSuggestModel: 'Suggest model',
          configReasoningEffort: 'Config reasoning',
          login: 'Login',
          logout: 'Logout',
          model: 'Model',
          reasoningEffort: 'Reasoning',
          info: 'Info',
          tools: 'Tools',
          skill: 'Skill',
          workspaceInfo: 'Workspace info',
          workspaceSync: 'Workspace sync',
          workspaceInit: 'Workspace init',
        },
      },
    },
  };
}

type ForgePanelAuxiliaryTestOptions = {
  readonly conversations?: readonly {
    readonly id: string;
    readonly title: string;
    readonly updated: string;
  }[];
  readonly selectedConversationId?: string;
  readonly selectedMarkdown?: string;
  readonly selectedDump?: string;
  readonly model?: string;
  readonly providerUrl?: string;
  readonly conversationId?: string;
  readonly loading?: boolean;
  readonly error?: string;
  readonly onRefresh?: () => void;
  readonly onSelectConversation?: (id: string) => void;
  readonly onDumpConversation?: (id: string) => void;
};

async function flushRender() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function isInputElement(element: Element): element is HTMLInputElement {
  return element instanceof HTMLInputElement;
}

function isButtonElement(element: Element): element is HTMLButtonElement {
  return element instanceof HTMLButtonElement;
}

function requireElement<T extends Element>(
  root: ParentNode,
  selector: string,
  predicate: (element: Element) => element is T,
) {
  const element = root.querySelector(selector);
  if (!element || !predicate(element)) {
    throw new Error(`Missing expected element: ${selector}`);
  }
  return element;
}

function mountForgePanel(onSendLine: (line: string) => void) {
  return mountForgePanelWithOptions(onSendLine, {});
}

function mountForgePanelWithOptions(
  onSendLine: (line: string) => void,
  auxiliaryOptions: ForgePanelAuxiliaryTestOptions,
) {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: createMessages() });
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp(defineComponent({
    setup() {
      return () => h(ForgePanel, {
        shellId: 'pty-forge',
        cwd: '/repo',
        onSendLine,
        auxiliary: {
          conversations: auxiliaryOptions.conversations ?? [],
          selectedConversationId: auxiliaryOptions.selectedConversationId ?? '',
          selectedMarkdown: auxiliaryOptions.selectedMarkdown ?? '',
          selectedDump: auxiliaryOptions.selectedDump ?? '',
          info: auxiliaryOptions.model
            ? {
                model: auxiliaryOptions.model,
                providerUrl: auxiliaryOptions.providerUrl ?? '',
                conversationId: auxiliaryOptions.conversationId ?? '',
              }
            : null,
          loading: auxiliaryOptions.loading ?? false,
          error: auxiliaryOptions.error ?? '',
          onRefresh: auxiliaryOptions.onRefresh ?? (() => {}),
          onSelectConversation: auxiliaryOptions.onSelectConversation ?? (() => {}),
          onDumpConversation: auxiliaryOptions.onDumpConversation ?? (() => {}),
        },
      });
    },
  }));
  app.use(i18n);
  app.mount(root);
  return { app, root };
}

describe('ForgePanel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders an xterm host bound to the Forge PTY id', async () => {
    // Given: a Forge PTY id created by the app shell session manager.
    const { app, root } = mountForgePanel(() => {});
    await flushRender();

    // When: the panel renders.
    const host = root.querySelector('[data-shell-id="pty-forge"]');

    // Then: xterm can attach to the exact host used by App.vue terminal plumbing.
    expect(host).toBeInstanceOf(HTMLElement);
    app.unmount();
  });

  it('sends typed prompts through Forge zsh colon syntax', async () => {
    // Given: a visible Forge prompt input.
    const onSendLine = vi.fn();
    const { app, root } = mountForgePanel(onSendLine);
    await flushRender();
    const input = requireElement(root, 'input[name="forge-prompt"]', isInputElement);
    const button = requireElement(root, 'button[data-forge-action="send"]', isButtonElement);

    // When: the user submits ordinary prompt text.
    input.dispatchEvent(new Event('focus'));
    input.value = 'summarize this repository';
    input.dispatchEvent(new Event('input'));
    await flushRender();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushRender();

    // Then: Forge receives a zsh ':' command and the input clears.
    expect(onSendLine).toHaveBeenCalledWith(': summarize this repository\n');
    expect(input.value).toBe('');
    app.unmount();
  });

  it('keeps the prompt at the bottom and prefixes prompts with the selected Forge function', async () => {
    // Given: the Forge terminal body and the bottom prompt bar are visible.
    const onSendLine = vi.fn();
    const { app, root } = mountForgePanel(onSendLine);
    await flushRender();
    const body = requireElement(root, '.forge-body', (element): element is HTMLElement => element instanceof HTMLElement);
    const form = requireElement(root, 'form[data-forge-prompt-bar]', (element): element is HTMLFormElement => element instanceof HTMLFormElement);
    const modeSelector = requireElement(root, 'button.forge-mode-trigger', isButtonElement);
    const input = requireElement(root, 'input[name="forge-prompt"]', isInputElement);

    // When: the user chooses Sage and submits text from the bottom composer.
    modeSelector.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushRender();
    const sage = requireElement(root, 'button[data-forge-mode="sage"]', isButtonElement);
    sage.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    input.value = 'inspect current repo';
    input.dispatchEvent(new Event('input'));
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await flushRender();

    // Then: the prompt follows the terminal body and sends the selected colon command.
    expect(body.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(onSendLine).toHaveBeenCalledWith(':sage inspect current repo\n');
    app.unmount();
  });

  it('does not duplicate a leading Forge colon command', async () => {
    // Given: the user already typed an explicit Forge command.
    const onSendLine = vi.fn();
    const { app, root } = mountForgePanel(onSendLine);
    await flushRender();
    const input = requireElement(root, 'input[name="forge-prompt"]', isInputElement);

    // When: the user presses Enter.
    input.value = ':sage inspect the config';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushRender();

    // Then: the exact command is sent once.
    expect(onSendLine).toHaveBeenCalledWith(':sage inspect the config\n');
    app.unmount();
  });

  it('keeps Forge commands in dedicated menus and the bottom function selector without duplicate toolbar shortcuts', async () => {
    // Given: the Forge panel renders its command controls.
    const { app, root } = mountForgePanel(() => {});
    await flushRender();

    // When: the user inspects the command surfaces.
    const modeSelector = requireElement(root, 'button.forge-mode-trigger', isButtonElement);
    const configModel = requireElement(root, 'button[data-forge-action="config-model"]', isButtonElement);
    const conversationClone = requireElement(root, 'button[data-forge-action="conversation-clone"]', isButtonElement);

    // Then: no obsolete direct shortcuts duplicate the selector and menu actions.
    expect(modeSelector).toBeInstanceOf(HTMLButtonElement);
    expect(configModel).toBeInstanceOf(HTMLButtonElement);
    expect(conversationClone).toBeInstanceOf(HTMLButtonElement);
    expect(root.querySelector('.forge-shortcuts')).toBeNull();
    expect(root.querySelector('button[data-forge-action="sage"]')).toBeNull();
    app.unmount();
  });

  it('sends command menu actions for config, temporary settings, status, workspace, and conversation groups', async () => {
    // Given: Forge command menus are rendered as terminal command controls.
    const onSendLine = vi.fn();
    const { app, root } = mountForgePanelWithOptions(onSendLine, {
      model: 'deepseek-v4-flash',
      providerUrl: 'https://opencode.ai/zen/go',
      conversationId: 'conv-1',
    });
    await flushRender();
    const terminalHost = requireElement(
      root,
      '[data-shell-id="pty-forge"]',
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    const terminalInput = document.createElement('textarea');
    terminalInput.className = 'xterm-helper-textarea';
    terminalHost.appendChild(terminalInput);
    const configModel = requireElement(root, 'button[data-forge-action="config-model"]', isButtonElement);
    const login = requireElement(root, 'button[data-forge-action="login"]', isButtonElement);
    const status = requireElement(root, 'button.forge-status-trigger', isButtonElement);
    const tools = requireElement(root, 'button[data-forge-action="tools"]', isButtonElement);
    const workspaceSync = requireElement(root, 'button[data-forge-action="workspace-sync"]', isButtonElement);
    const retry = requireElement(root, 'button[data-forge-action="retry"]', isButtonElement);

    // When: the user invokes one command from each group and opens the status popover.
    configModel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    login.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    status.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    tools.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    workspaceSync.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushRender();

    // Then: command controls write colon commands to the live PTY and status floats above the terminal UI.
    expect(root.querySelector('.forge-status-dropdown')).toBeInstanceOf(HTMLElement);
    expect(root.querySelector('.forge-status-dropdown.is-right-aligned')).toBeInstanceOf(HTMLElement);
    expect(root.querySelector('.forge-status-popup')).toBeInstanceOf(HTMLElement);
    expect(root.textContent).toContain('deepseek-v4-flash');
    expect(onSendLine).toHaveBeenCalledWith(':config-model\n');
    expect(onSendLine).toHaveBeenCalledWith(':login\n');
    expect(onSendLine).toHaveBeenCalledWith(':tools\n');
    expect(onSendLine).toHaveBeenCalledWith(':workspace-sync\n');
    expect(onSendLine).toHaveBeenCalledWith(':retry\n');
    expect(document.activeElement).toBe(terminalInput);
    expect(root.querySelectorAll('.forge-command-dropdown.is-right-aligned')).toHaveLength(2);
    app.unmount();
  });

  it('renders structured Forge reads as sidebar metadata and preview panes', async () => {
    // Given: Forge CLI auxiliary output has been loaded separately from the live PTY.
    const { app, root } = mountForgePanelWithOptions(() => {}, {
      conversations: [
        { id: 'conv-1', title: 'Repository setup', updated: '9m ago' },
        { id: 'conv-2', title: '[empty]', updated: '1h ago' },
      ],
      selectedConversationId: 'conv-1',
      selectedMarkdown: 'Last assistant markdown preview',
      selectedDump: '{"id":"conv-1"}',
      model: 'deepseek-v4-flash',
      providerUrl: 'https://opencode.ai/zen/go',
      conversationId: 'conv-1',
    });
    await flushRender();

    // When: the panel renders the auxiliary sidebar next to xterm.
    const listItem = root.querySelector('[data-forge-conversation-id="conv-1"]');
    const preview = root.querySelector('[data-forge-preview="markdown"]');
    const dump = root.querySelector('[data-forge-preview="dump"]');
    const terminalHost = root.querySelector('[data-shell-id="pty-forge"]');

    // Then: metadata is visible without replacing the realtime terminal surface.
    expect(root.textContent).toContain('deepseek-v4-flash');
    expect(root.textContent).toContain('Repository setup');
    expect(root.textContent).toContain('9m ago');
    expect(listItem).toBeInstanceOf(HTMLElement);
    expect(preview?.textContent).toContain('Last assistant markdown preview');
    expect(dump?.textContent).toContain('{"id":"conv-1"}');
    expect(terminalHost).toBeInstanceOf(HTMLElement);
    app.unmount();
  });

  it('requests structured Forge list, show, dump, and info reads through auxiliary callbacks', async () => {
    // Given: auxiliary callbacks are provided by App.vue command orchestration.
    const onRefresh = vi.fn();
    const onSelectConversation = vi.fn();
    const onDumpConversation = vi.fn();
    const { app, root } = mountForgePanelWithOptions(() => {}, {
      conversations: [{ id: 'conv-1', title: 'Repository setup', updated: '9m ago' }],
      selectedConversationId: 'conv-1',
      onRefresh,
      onSelectConversation,
      onDumpConversation,
    });
    await flushRender();
    const refresh = requireElement(root, 'button[data-forge-action="refresh-auxiliary"]', isButtonElement);
    const conversation = requireElement(root, 'button[data-forge-conversation-id="conv-1"]', isButtonElement);
    const dump = requireElement(root, 'button[data-forge-action="dump-conversation"]', isButtonElement);

    // When: the user refreshes metadata, selects a conversation, and requests a dump.
    refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    conversation.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    dump.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushRender();

    // Then: structured reads are delegated through callbacks, not through xterm input.
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onSelectConversation).toHaveBeenCalledWith('conv-1');
    expect(onDumpConversation).toHaveBeenCalledWith('conv-1');
    app.unmount();
  });

  it('lets the auxiliary sidebar hide and reopen through drag gestures while preserving conversation commands', async () => {
    // Given: the structured auxiliary sidebar is visible next to the terminal.
    const onSendLine = vi.fn();
    const { app, root } = mountForgePanelWithOptions(onSendLine, {
      conversations: [{ id: 'conv-1', title: 'Repository setup', updated: '9m ago' }],
      selectedConversationId: 'conv-1',
    });
    await flushRender();
    const resizer = root.querySelector('[data-forge-sidebar-resizer]');
    const clone = requireElement(root, 'button[data-forge-action="conversation-clone"]', isButtonElement);
    const rename = requireElement(root, 'button[data-forge-action="conversation-rename"]', isButtonElement);
    const tree = requireElement(root, 'button[data-forge-action="conversation-tree"]', isButtonElement);
    const deleteButton = requireElement(root, 'button[data-forge-action="conversation-delete"]', isButtonElement);
    const resizeHandle = requireElement(
      root,
      '[data-forge-sidebar-resizer]',
      (element): element is HTMLElement => element instanceof HTMLElement,
    );

    // When: the user runs sidebar conversation commands, drags right to hide, then left to reveal the rail.
    clone.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    rename.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    tree.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    resizeHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 400 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 500 }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 500 }));
    await flushRender();

    const hiddenResizeHandle = requireElement(
      root,
      '[data-forge-sidebar-resizer]',
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    hiddenResizeHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 500 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400 }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 400 }));
    await flushRender();

    // Then: the sidebar owns conversation command buttons and can collapse and restore without overlapping action buttons.
    expect(resizer).toBeInstanceOf(HTMLElement);
    expect(onSendLine).toHaveBeenCalledWith(':clone\n');
    expect(onSendLine).toHaveBeenCalledWith(':conversation-rename\n');
    expect(onSendLine).toHaveBeenCalledWith(':conversation-tree\n');
    expect(onSendLine).toHaveBeenCalledWith(':delete\n');
    expect(root.querySelector('[data-forge-action="hide-sidebar"]')).toBeNull();
    expect(root.querySelector('[data-forge-action="show-sidebar"]')).toBeNull();
    expect(root.querySelector('.forge-auxiliary-panel')).toBeInstanceOf(HTMLElement);
    expect(root.querySelector('[data-shell-id="pty-forge"]')).toBeInstanceOf(HTMLElement);
    app.unmount();
  });
});
