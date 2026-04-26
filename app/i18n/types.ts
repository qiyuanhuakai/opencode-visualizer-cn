export type Locale = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'eo';

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
      sessionRenameFailed: string;
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
      sessionRenameInvalidResponse: string;
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
      renamingSession: string;
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
      cancel: string;
      confirm: string;
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
      rename: string;
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
      token: string;
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
    token: {
      noSession: string;
      noData: string;
      model: string;
      contextLimit: string;
      totalTokens: string;
      usagePercent: string;
      inputTokens: string;
      outputTokens: string;
      reasoningTokens: string;
      cacheTokens: string;
      userMessages: string;
      assistantMessages: string;
      totalCost: string;
      createdTime: string;
      lastActivity: string;
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
    custom: {
      title: string;
      back: string;
      description: string;
      entryDescription: string;
      submit: string;
      fields: {
        providerId: { label: string; placeholder: string; description: string };
        name: { label: string; placeholder: string };
        baseUrl: { label: string; placeholder: string };
        apiKey: { label: string; placeholder: string; description: string };
      };
      models: {
        label: string;
        id: { label: string; placeholder: string };
        name: { label: string; placeholder: string };
        add: string;
        remove: string;
      };
      headers: {
        label: string;
        key: { label: string; placeholder: string };
        value: { label: string; placeholder: string };
        add: string;
        remove: string;
      };
      errors: {
        providerIdRequired: string;
        providerIdFormat: string;
        providerIdExists: string;
        nameRequired: string;
        baseUrlRequired: string;
        baseUrlFormat: string;
        required: string;
        duplicate: string;
      };
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
    messages: {
      connected: string;
      disconnected: string;
      providerEnabled: string;
      providerDisabled: string;
      modelEnabled: string;
      modelDisabled: string;
    };
    prompts: {
      selectAuthMethod: string;
      enterValueForProvider: string;
      enterApiKey: string;
      pasteAuthCode: string;
      completeOAuth: string;
    };
    confirm: {
      disconnect: string;
    };
    providerNotes: {
      opencode: string;
      'opencode-go': string;
      anthropic: string;
      'github-copilot': string;
      openai: string;
      google: string;
      openrouter: string;
      vercel: string;
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
      sessionTree: {
        pinProject: string;
        unpinProject: string;
        pinSandbox: string;
        unpinSandbox: string;
        pinSession: string;
        unpinSession: string;
      };
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
    historySubagent: string;
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
      zhTW: string;
      ja: string;
      eo: string;
    };
    enterToSend: {
      label: string;
      description: string;
    };
    showMinimizeButtons: {
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
    terminalFontSizePx: {
      label: string;
      description: string;
    };
    appFontSizePx: {
      label: string;
      description: string;
    };
    messageFontSizePx: {
      label: string;
      description: string;
    };
    uiFontSizePx: {
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
    floatingPreviewWordWrap: {
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
    optional: string;
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
    subagent: string;
    delegation: string;
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
  codexPanel: {
    title: string;
    urlLabel: string;
    tokenLabel: string;
    connect: string;
    connecting: string;
    disconnect: string;
    threads: string;
    newThread: string;
    noThreads: string;
    connectToLoad: string;
    showArchived: string;
    showHidden: string;
    refreshThreads: string;
    rename: string;
    threadName: string;
    renamePlaceholder: string;
    unsubscribe: string;
    interrupt: string;
    archive: string;
    unarchive: string;
    fork: string;
    rollback: string;
    rollbackTurns: string;
    hide: string;
    unhide: string;
    pin: string;
    unpin: string;
    pinned: string;
    turnStatus: string;
    turnLabel: string;
    turnActive: string;
    events: string;
    promptPlaceholder: string;
    send: string;
    sending: string;
    loadingThread: string;
    noTranscript: string;
    approvalTitle: string;
    approvalScope: string;
    sandbox: string;
    sandboxCwd: string;
    sandboxBrowse: string;
    noSandboxCwd: string;
    sandboxEmpty: string;
      filePreview: string;
      closePreview: string;
      noHiddenThreads: string;
      accountLogin: string;
      accountLogout: string;
      apiKeyPlaceholder: string;
      deviceCodeInstruction: string;
      login: string;
      loginApiKey: string;
      loginBrowser: string;
      loginChatgpt: string;
      loginDeviceCode: string;
      loginPending: string;
      approvalCommand: string;
      approvalCwd: string;
      approvalDecisionAccept: string;
      approvalDecisionAcceptForSession: string;
      approvalDecisionAmend: string;
      approvalDecisionCancel: string;
      approvalDecisionDecline: string;
      approvalExecpolicyAmendment: string;
      approvalFileChanges: string;
      approvalHost: string;
      approvalNetworkRequest: string;
      approvalProtocol: string;
      approvalReason: string;
      approvalTypeCommandExecution: string;
      approvalTypeFileChange: string;
      approvalTypeNetworkAccess: string;
      commandCwd: string;
      commandExec: string;
      commandInput: string;
      commandInputPlaceholder: string;
      commandRun: string;
      fsBreadcrumbRoot: string;
      fsNewThreadHere: string;
      fsParentDirectory: string;
      fsPathPlaceholder: string;
      messageAssistant: string;
      messageSystem: string;
      messageUser: string;
      transcriptCommandExecution: string;
      transcriptCompaction: string;
      transcriptFileChange: string;
      transcriptImage: string;
      transcriptReasoning: string;
      transcriptReviewMode: string;
      transcriptToolCall: string;
      transcriptWebSearch: string;
      rateLimits: string;
      refreshRateLimits: string;
      reviewBranchPlaceholder: string;
      reviewCommitPlaceholder: string;
      reviewCustomPlaceholder: string;
      reviewDeliveryDetached: string;
      reviewDeliveryInline: string;
      reviewDeliveryLabel: string;
      reviewEntering: string;
      reviewExiting: string;
      reviewStart: string;
      reviewTargetBranch: string;
      reviewTargetCommit: string;
      reviewTargetCustom: string;
      reviewTargetLabel: string;
      reviewTargetUncommitted: string;
      // Tabs
      tabChat: string;
      tabFiles: string;
      tabModels: string;
      tabSkills: string;
      tabPlugins: string;
      tabMcp: string;
      tabConfig: string;
      // fs additions
      fsCreateFile: string;
      fsCreateDirectory: string;
      fsNewFileTitle: string;
      fsNewDirectoryTitle: string;
      fsFileNamePlaceholder: string;
      fsFileContentPlaceholder: string;
      fsDirectoryNamePlaceholder: string;
      fsWriteSuccess: string;
      fsWriteError: string;
      fsCreateDirectorySuccess: string;
      fsCreateDirectoryError: string;
      // model
      modelsTitle: string;
      modelsNoModels: string;
      modelsIncludeHidden: string;
      modelsId: string;
      modelsDisplayName: string;
      modelsDefault: string;
      modelsHidden: string;
      modelsModalities: string;
      modelsPersonality: string;
      modelsReasoningEffort: string;
      modelsUpgradeAvailable: string;
      // skills
      skillsTitle: string;
      skillsNoSkills: string;
      skillsCwd: string;
      skillsName: string;
      skillsDescription: string;
      skillsEnabled: string;
      skillsDisabled: string;
      skillsDependencies: string;
      skillsRefresh: string;
      skillsForceReload: string;
      skillsToggleEnable: string;
      skillsToggleDisable: string;
      skillsWriteSuccess: string;
      skillsWriteError: string;
      // marketplace
      marketplaceAddTitle: string;
      marketplaceName: string;
      marketplacePath: string;
      marketplaceUrl: string;
      marketplaceType: string;
      marketplaceAddSuccess: string;
      marketplaceAddError: string;
      // plugin
      pluginsTitle: string;
      pluginsNoPlugins: string;
      pluginsMarketplace: string;
      pluginsInstall: string;
      pluginsUninstall: string;
      pluginsInstalling: string;
      pluginsUninstalling: string;
      pluginsInstalled: string;
      pluginsFeatured: string;
      pluginsReadMore: string;
      pluginsLoadError: string;
      // mcpServer
      mcpTitle: string;
      mcpNoServers: string;
      mcpServerName: string;
      mcpStatus: string;
      mcpTools: string;
      mcpResources: string;
      mcpAuth: string;
      mcpOAuthLogin: string;
      mcpReloadConfig: string;
      mcpReloading: string;
      mcpReloadSuccess: string;
      mcpToolCall: string;
      mcpResourceRead: string;
      mcpAuthRequired: string;
      mcpAuthPending: string;
      mcpAuthCompleted: string;
      // config
      configTitle: string;
      configIncludeLayers: string;
      configRefresh: string;
      configNoConfig: string;
      configMerged: string;
      configLayers: string;
      fsRemove: string;
      fsRemoveSuccess: string;
      fsRemoveError: string;
      fsWatch: string;
      fsUnwatch: string;
      fsGetMetadata: string;
      fsCopy: string;
      fsCopySuccess: string;
      fsCopyError: string;
      steerTurn: string;
      steerTurnPlaceholder: string;
      shellCommand: string;
      shellCommandPlaceholder: string;
      shellCommandRun: string;
      compactThread: string;
      compactThreadConfirm: string;
      injectItems: string;
      loadedThreads: string;
      loadedThreadsEmpty: string;
      tokenUsage: string;
      tokenUsageInput: string;
      tokenUsageOutput: string;
      tokenUsageReasoning: string;
      tokenUsageTotal: string;
      planStepPending: string;
      planStepInProgress: string;
      planStepCompleted: string;
      diffUpdated: string;
      // New tabs
      tabApps: string;
      tabExperimentalFeatures: string;
      tabCollaborationModes: string;
      tabExternalAgentConfig: string;
      tabFeedback: string;
      // apps
      appsTitle: string;
      appsNoApps: string;
      appName: string;
      appDescription: string;
      appAccessible: string;
      appNotAccessible: string;
      appEnabled: string;
      appDisabled: string;
      appInstallUrl: string;
      // experimental features
      experimentalFeaturesTitle: string;
      experimentalFeaturesNoFeatures: string;
      featureName: string;
      featureStage: string;
      featureDescription: string;
      featureEnabled: string;
      featureDisabled: string;
      featureDefaultEnabled: string;
      // collaboration modes
      collaborationModesTitle: string;
      collaborationModesNoModes: string;
      collaborationModeName: string;
      // external agent config
      externalAgentConfigTitle: string;
      detect: string;
      includeHome: string;
      import_: string;
      importSuccess: string;
      importError: string;
      externalAgentConfigNoItems: string;
      // feedback
      feedbackTitle: string;
      feedbackClassification: string;
      feedbackReason: string;
      feedbackLogs: string;
      feedbackSubmit: string;
      feedbackSubmitSuccess: string;
      feedbackSubmitError: string;
      // tool / dynamic tool
      toolUserInputTitle: string;
      toolUserInputOther: string;
      dynamicToolCallTitle: string;
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}
