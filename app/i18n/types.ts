export type Locale = 'en' | 'zh-CN';

export interface LocaleMessages {
  app: {
    title: string;
    loading: string;
    login: {
      title: string;
      username: string;
      password: string;
      url: string;
      authRequired: string;
      connect: string;
      retry: string;
      abort: string;
      error: string;
    };
    connection: {
      connecting: string;
      connected: string;
      reconnecting: string;
      disconnected: string;
    };
    status: {
      ready: string;
      loadingServerPath: string;
      loadingProjects: string;
      loadingSessionHistory: string;
      loadingWorktreeState: string;
      synchronizing: string;
      forking: string;
      forked: string;
      reverting: string;
      reverted: string;
      undoing: string;
      undone: string;
      sending: string;
      sent: string;
      stopping: string;
      stopped: string;
      shellReady: string;
      next: string;
      idle: string;
      thinking: string;
    };
    error: {
      noWorktreeSelected: string;
      actionDisabled: string;
      stillLoading: string;
      notConnected: string;
      unavailable: string;
      noSessionSelected: string;
      unsupportedAttachment: string;
      attachmentFailed: string;
      sendFailed: string;
      stopFailed: string;
      worktreeCreateFailed: string;
      worktreeDeleteFailed: string;
      worktreeBaseNotSet: string;
      sessionCreateFailed: string;
      sessionDeleteFailed: string;
      sessionArchiveFailed: string;
      sessionUnarchiveFailed: string;
      sessionPinFailed: string;
      sessionUnpinFailed: string;
      sessionForkFailed: string;
      sessionRevertFailed: string;
      sessionUndoFailed: string;
      batchOperationPartialFailure: string;
      fileLoadFailed: string;
      fileReadFailed: string;
      treeLoadFailed: string;
    };
    dock: {
      restoreTitle: string;
      restoreFallbackWindow: string;
    };
    windowTitles: {
      shell: string;
      oneShotPty: string;
      threadHistory: string;
      image: string;
      thought: string;
      debugSessionGraph: string;
      debugNotifications: string;
      reasoningWithTag: string;
      reasoningSimple: string;
      question: string;
      permission: string;
    };
    debug: {
      session: string;
      notification: string;
      availableSubcommands: string;
      sessionOpened: string;
      notificationOpened: string;
      unknownSubcommand: string;
      notificationState: string;
      permissionWindows: string;
      questionWindows: string;
    };
    errors: {
      sseConnectFailed: string;
    };
    descriptions: {
      openLocalShell: string;
    };
    menu: {
      debugUtilities: string;
    };
    actions: {
      creatingWorktree: string;
      deletingWorktree: string;
      creatingSession: string;
      deletingSession: string;
      archivingSession: string;
      unarchivingSession: string;
      pinningSession: string;
      unpinningSession: string;
      batchSessionOperation: string;
      fork: string;
      revert: string;
      undo: string;
      sending: string;
      sendingCommands: string;
      stopping: string;
      questionReply: string;
      questionReject: string;
      permissionReply: string;
    };
    brand: {
      title: string;
    };
    notification: {
      permission: string;
      question: string;
      idle: string;
      sessionIdle: string;
      sessionRequiresResponse: string;
    };
    read: {
      noActiveDirectory: string;
      pathMissing: string;
      emptyDirectory: string;
      binaryFile: string;
      failedToLoad: string;
      binaryContentNotIncluded: string;
      noActiveDirectorySelected: string;
    };
    git: {
      loadingDiff: string;
      loadingAllChanges: string;
      loading: string;
      filesChanged: string;
      loadingCommit: string;
      commitTitle: string;
      staged: string;
      unstaged: string;
      stagedChanges: string;
      unstagedChanges: string;
      workingTree: string;
    };
    prompt: {
      editMessage: string;
    };
  };
  topPanel: {
    title: string;
    noNotifications: string;
    pendingNotifications: string;
    selectSession: string;
    searchPlaceholder: string;
    management: {
      title: string;
      done: string;
      unselectVisible: string;
      selectVisible: string;
      selectedCount: string;
      clear: string;
      pin: string;
      unpin: string;
      archive: string;
      unarchive: string;
      delete: string;
    };
    empty: {
      noMatchingSessions: string;
      noWorktrees: string;
    };
    projectSettings: string;
    newSession: string;
    newSessionShortcut: string;
    createSandbox: string;
    openShell: string;
    managementMode: {
      enter: string;
      exit: string;
    };
    badges: {
      pinned: string;
      archived: string;
    };
    sessionActions: {
      unpin: string;
      pin: string;
      unarchive: string;
      archive: string;
      deletePermanently: string;
      select: string;
      unselect: string;
    };
    confirm: {
      deleteWorktree: string;
      deleteSession: string;
      deleteSessions: string;
    };
    meta: {
      created: string;
      updated: string;
    };
    openProject: string;
    settings: string;
    providerManager: string;
    statusMonitor: string;
    autoWindowsSuppressed: string;
    suppressAutoWindows: string;
    logout: string;
    github: string;
  };
  statusMonitor: {
    title: string;
    close: string;
    refresh: string;
    refreshing: string;
    loading: string;
    error: string;
    retry: string;
    empty: string;
    common: {
      totalLabel: string;
    };
    tabs: {
      server: string;
      mcp: string;
      lsp: string;
      plugins: string;
      skills: string;
    };
    server: {
      status: string;
      healthy: string;
      unhealthy: string;
      version: string;
      noData: string;
    };
    mcp: {
      total: string;
      connected: string;
      disabled: string;
      failed: string;
      needsAuth: string;
      needsRegistration: string;
      noData: string;
      enable: string;
      disable: string;
      toggleFailed: string;
    };
    lsp: {
      total: string;
      connected: string;
      error: string;
      noData: string;
    };
    plugins: {
      total: string;
      noData: string;
    };
    skills: {
      total: string;
      noData: string;
      unsupported: string;
    };
  };
  providerManager: {
    title: string;
    close: string;
    tabs: {
      providers: string;
      models: string;
    };
    badges: {
      disconnected: string;
      enabled: string;
      disabled: string;
      recommended: string;
    };
    sections: {
      connected: string;
      connectedDescription: string;
      connectedEmpty: string;
      popular: string;
      popularDescription: string;
      popularEmpty: string;
      allProviders: string;
      allProvidersDescription: string;
    };
    providerStats: {
      models: string;
      enabledModels: string;
    };
    authMethodsLabel: string;
    actions: {
      available: string;
      connect: string;
      disconnect: string;
      useModel: string;
      enabled: string;
      disabled: string;
    };
    models: {
      searchPlaceholder: string;
      total: string;
      disabledCount: string;
      empty: string;
      context: string;
      output: string;
      capabilities: {
        attachment: string;
        reasoning: string;
        toolcall: string;
      };
    };
  };
  sidePanel: {
    tabs: {
      todo: string;
      session: string;
      tree: string;
    };
    expandPanel: string;
    collapsePanel: string;
    session: {
      title: string;
      noPinned: string;
      unpin: string;
    };
    todo: {
      title: string;
      empty: string;
      expand: string;
      collapse: string;
    };
    tree: {
      title: string;
      loading: string;
      error: string;
    };
  };
  inputPanel: {
    placeholder: string;
    loadingAgents: string;
    loadingModels: string;
    loading: string;
    searchPlaceholder: string;
    noMatchingModels: string;
    bookmark: string;
    removeFromFavorites: string;
    attach: string;
    agent: string;
    model: string;
    variant: string;
    selectAgent: string;
    selectModel: string;
     selectVariant: string;
     agentTitle: string;
     modelTitle: string;
     variantTitle: string;
     selectAtAgent: string;
     atAgentTitle: string;
     bookmarkCurrentInput: string;
    openBookmarks: string;
    removeFromFavoritesConfirm: string;
    bookmarked: string;
    stop: string;
    sendTooltipEnter: string;
    sendTooltipCtrlEnter: string;
    send: {
      enterToSend: string;
      ctrlEnterToSend: string;
      stop: string;
    };
    suppressWindows: {
      suppressed: string;
      suppress: string;
    };
  };
  settings: {
    title: string;
    fontsPageTitle: string;
    themePageTitle: string;
    close: string;
    backToRoot: string;
    language: {
      label: string;
      description: string;
      en: string;
      zhCN: string;
    };
    enterToSend: {
      label: string;
      description: string;
    };
    showMinimizeButtons: {
      label: string;
      description: string;
    };
    pinnedSessionsLimit: {
      label: string;
      description: string;
    };
    terminalFontFamily: {
      label: string;
      description: string;
    };
    appMonospaceFontFamily: {
      label: string;
      description: string;
    };
    fontSettings: {
      label: string;
      description: string;
    };
    systemFonts: {
      label: string;
      scan: string;
      loading: string;
      unsupported: string;
      error: string;
      regular: string;
    };
    fontStatus: {
      available: string;
      missing: string;
      generic: string;
    };
    fontPresetsLabel: string;
    customFontStackLabel: string;
    fontPresets: {
      default: string;
      firaCodeNerd: string;
      caskaydiaNerd: string;
      iosevkaTerm: string;
      jetbrainsMono: string;
      sfMono: string;
      firaCode: string;
    };
    dockAlwaysOpen: {
      label: string;
      description: string;
    };
    showOpenInEditorButton: {
      label: string;
      description: string;
    };
    openInEditorMaxSizeMb: {
      label: string;
      description: string;
    };
    theme: {
      label: string;
      description: string;
      presetLabel: string;
      presetDescription: string;
      managementLabel: string;
      managementDescription: string;
      currentProfileLabel: string;
      currentProfileDefault: string;
      currentProfilePreset: string;
      importAction: string;
      importing: string;
      importHint: string;
      importError: string;
      exportCurrentAction: string;
      exportTemplateAction: string;
      exportCurrentFallbackName: string;
      removeExternal: string;
      externalBadge: string;
      externalDescription: string;
      schemaLink: string;
      presetNames: {
        default: string;
        ocean: string;
        forest: string;
      };
      presetBadges: {
        balanced: string;
        cool: string;
        natural: string;
        expressive: string;
      };
      presetDescriptions: {
        default: string;
        ocean: string;
        forest: string;
        sakura: string;
      };
      customLabel: string;
      topPanel: string;
      sidePanel: string;
      inputPanel: string;
      outputPanel: string;
      topDropdown: string;
      modalPanel: string;
      pageBackground: string;
      chatCard: string;
      bg: string;
      text: string;
      border: string;
      accent: string;
      controlBg: string;
      activeBg: string;
      activeText: string;
      textMuted: string;
      reset: string;
    };
  };
  floatingWindow: {
    search: string;
    previous: string;
    next: string;
    close: string;
    minimize: string;
    restore: string;
    copied: string;
    copy: string;
    tool: string;
    minimizeWindow: string;
    closeWindow: string;
    openInEditor: string;
    previousMatch: string;
    nextMatch: string;
    closeSearch: string;
    noResults: string;
  };
  toolTitles: {
    patch: string;
    shell: string;
    read: string;
    grep: string;
    glob: string;
    ls: string;
    fetch: string;
    search: string;
    code: string;
    task: string;
    write: string;
    edit: string;
    batch: string;
  };
  toolWindow: {
    permission: {
      title: string;
      tool: string;
      session: string;
      items: string;
      none: string;
      alwaysAllow: string;
      once: string;
      always: string;
      reject: string;
      patternsTitle: string;
      metadataTitle: string;
      message: string;
      call: string;
    };
    question: {
      title: string;
      itemCount: string;
      session: string;
      tool: string;
      modeMultiple: string;
      modeSingle: string;
      customAnswer: string;
      reply: string;
      reject: string;
      message: string;
      call: string;
    };
    bash: {
      title: string;
      running: string;
    };
    shell: {
      title: string;
      running: string;
    };
    read: {
      title: string;
    };
    edit: {
      title: string;
    };
    grep: {
      title: string;
      running: string;
      pattern: string;
      directory: string;
      includeLabel: string;
    };
    glob: {
      title: string;
      running: string;
      pattern: string;
      directory: string;
      includeLabel: string;
    };
    web: {
      title: string;
      urlLabel: string;
      queryLabel: string;
      fetching: string;
      searching: string;
    };
    task: {
      title: string;
    };
    subagent: {
      title: string;
    };
    reasoning: {
      title: string;
    };
    default: {
      title: string;
    };
  };
  projectPicker: {
    title: string;
    placeholder: string;
    open: string;
    noMatches: string;
    noSubdirectories: string;
  };
  projectSettings: {
    title: string;
    name: string;
    syncFromPackage: string;
    icon: string;
    iconAlt: string;
    dropHint: string;
    sizeHint: string;
    color: string;
    startupScript: string;
    startupScriptHint: string;
    startupPlaceholder: string;
    saving: string;
    save: string;
  };
  treeView: {
    local: string;
    remote: string;
    tags: string;
    createBranch: string;
    checkout: string;
    merge: string;
    rebase: string;
    rename: string;
    delete: string;
    noBranches: string;
    searchBranches: string;
    searchFiles: string;
    loadingBranches: string;
    mergeTooltip: string;
    createBranchTooltip: string;
    deleteBranchTooltip: string;
    mergeRefTitle: string;
    createBranchTitle: string;
    noGit: string;
    treeMode: string;
    staged: string;
    changes: string;
    allFiles: string;
    noFiles: string;
    collapseDirectory: string;
    expandDirectory: string;
    reloadFileTree: string;
    aheadOfRemote: string;
    behindRemote: string;
    remoteFallback: string;
    branch: {
      directory: string;
      gitUnavailable: string;
      tracking: string;
      currentOnly: string;
      headPrefix: string;
    };
    disabledReason: {
      alreadyOnBranch: string;
      worktreeInUse: string;
      localExists: string;
    };
    confirm: {
      createBranchFrom: string;
      mergeIntoCurrent: string;
      deleteBranch: string;
      runCommand: string;
    };
    diffStats: {
      insertions: string;
      deletions: string;
      clickToOpen: string;
    };
    fetch: string;
  };
  common: {
    loading: string;
    error: string;
    aborted: string;
    retry: string;
    cancel: string;
    confirm: string;
    close: string;
    save: string;
    delete: string;
    edit: string;
    add: string;
    remove: string;
    search: string;
    filter: string;
    none: string;
    empty: string;
    more: string;
    less: string;
    expand: string;
    collapse: string;
    show: string;
    hide: string;
    on: string;
    off: string;
    yes: string;
    no: string;
    ok: string;
    submit: string;
    reset: string;
    clear: string;
    refresh: string;
    reload: string;
    undo: string;
    redo: string;
    copy: string;
    paste: string;
    cut: string;
    selectAll: string;
    deselectAll: string;
    open: string;
    back: string;
    next: string;
    previous: string;
    finish: string;
    start: string;
    stop: string;
    pause: string;
    resume: string;
    skip: string;
    cont: string;
    continue: string;
    done: string;
    pending: string;
    processing: string;
    completed: string;
    failed: string;
    success: string;
    warning: string;
    info: string;
    subagent: string;
  };
  messageViewer: {
    rendered: string;
    source: string;
  };
  render: {
    copyCode: string;
    copied: string;
    copyCodeAria: string;
    copyMarkdownAria: string;
    renderFailed: string;
  };
  threadHistory: {
    thinking: string;
    question: string;
  };
  threadFooter: {
    inputTokens: string;
    outputTokens: string;
    reasoningTokens: string;
    diff: string;
    revert: string;
  };
  threadBlock: {
    confirmFork: string;
    confirmRevert: string;
    confirmUndoRevert: string;
    historyTitle: string;
    historyLabel: string;
    fork: string;
    undo: string;
  };
  imageViewer: {
    failedToLoad: string;
  };
  outputPanel: {
    scrollToLatest: string;
    loadOlder: string;
    loadingOlder: string;
    loadOlderFailed: string;
  };
  errors: {
    timedOut: string;
    opencodeUrlNotConfigured: string;
    ptyCreateFailed: string;
    ptyCommandTimedOut: string;
    ptySocketFailed: string;
    ptyCommandFailed: string;
    sseUrlEmpty: string;
    sseConnectFailed: string;
    sseConnectionAborted: string;
    stateSyncFailed: string;
    projectIdRequired: string;
    sessionCreateInvalidResponse: string;
    sessionCreateMissingProjectId: string;
    sessionForkInvalidResponse: string;
    sessionForkMissingProjectId: string;
    sessionArchiveInvalidResponse: string;
    sessionUnarchiveInvalidResponse: string;
    sessionPinInvalidResponse: string;
    sessionUnpinInvalidResponse: string;
    worktreeCreateInvalidResponse: string;
    noAvailableProject: string;
    failedToResolveSessionId: string;
    failedToResolveCreatedSession: string;
    sessionCreateEmptyWorktree: string;
    sessionCreateEmptyDirectory: string;
    noFilesInWorktreeSnapshot: string;
    noFilesInCommitSnapshot: string;
  };
  time: {
    inHours: string;
    inMinutes: string;
    inSeconds: string;
  };
  debug: {
    projectTreeTitle: string;
    projectsCount: string;
    sessionsTotal: string;
    projectLabel: string;
    worktreeLabel: string;
    nameLabel: string;
    colorLabel: string;
    timeLabel: string;
    createdLabel: string;
    updatedLabel: string;
    initializedLabel: string;
    noSandboxes: string;
    sandboxLabel: string;
    branchLabel: string;
    rootSessionsLabel: string;
    noSessions: string;
    sessionStatus: {
      busy: string;
      retry: string;
      idle: string;
    };
    dirLabel: string;
    parentLabel: string;
    archivedLabel: string;
    revertLabel: string;
    root: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}
