<template>
  <section class="codex-panel" :aria-label="t('codexPanel.title')">
    <header class="codex-panel-header">
      <label class="codex-url-field">
        <span>{{ t('codexPanel.urlLabel') }}</span>
        <input
          v-model="api.url.value"
          class="codex-input"
          type="url"
          spellcheck="false"
          :disabled="api.status.value === 'connecting' || api.connected.value"
          placeholder="ws://localhost:23004/codex"
        />
      </label>
      <label class="codex-token-field">
        <span>{{ t('codexPanel.tokenLabel') }}</span>
        <input
          v-model="api.bridgeToken.value"
          class="codex-input"
          type="password"
          autocomplete="off"
          :disabled="api.status.value === 'connecting' || api.connected.value"
          :placeholder="t('common.optional')"
        />
      </label>
      <button
        type="button"
        class="codex-primary-button"
        :disabled="api.status.value === 'connecting'"
        @click="api.connected.value ? api.disconnect() : connect()"
      >
        {{
          api.connected.value
            ? t('codexPanel.disconnect')
            : api.status.value === 'connecting'
              ? t('codexPanel.connecting')
              : t('codexPanel.connect')
        }}
      </button>
     </header>

     <!-- Account status and login panel -->
     <div class="codex-account-status" :class="{ 'has-login-panel': showLoginPanel }">
       <button
         v-if="!api.account.value"
         type="button"
         class="codex-small-button"
         :disabled="api.loginPending.value"
         :title="t('codexPanel.accountLogin')"
         @click="showLoginPanel = !showLoginPanel"
       >
         <Icon icon="mdi:account" width="16" />
       </button>
       <div v-else class="codex-account-badge">
         <Icon icon="mdi:account-check" width="14" />
         <span>{{ api.account.value.type }}</span>
         <span v-if="api.accountPlanType.value" class="codex-plan-type">{{ api.accountPlanType.value }}</span>
         <button
           type="button"
           class="codex-icon-button"
           :title="t('codexPanel.accountLogout')"
           @click="api.logoutAccount()"
         >
           <Icon icon="mdi:logout" width="14" />
         </button>
       </div>
     </div>

     <div v-if="showLoginPanel" class="codex-login-panel">
       <div class="codex-login-methods">
         <!-- API Key login -->
         <div class="codex-login-section">
           <span class="codex-login-label">{{ t('codexPanel.loginApiKey') }}</span>
           <input
             v-model="apiKeyInput"
             class="codex-input"
             type="password"
             :placeholder="t('codexPanel.apiKeyPlaceholder')"
             :disabled="api.loginPending.value"
           />
           <button
             type="button"
             class="codex-small-text-button"
             :disabled="api.loginPending.value || !apiKeyInput.trim()"
             @click="api.loginWithApiKey(apiKeyInput)"
           >
             {{ t('codexPanel.login') }}
           </button>
         </div>

         <!-- ChatGPT login -->
         <div class="codex-login-section">
           <span class="codex-login-label">{{ t('codexPanel.loginChatgpt') }}</span>
           <button
             type="button"
             class="codex-small-text-button"
             :disabled="api.loginPending.value"
             @click="api.loginWithChatgpt()"
           >
             {{ t('codexPanel.loginBrowser') }}
           </button>
           <button
             type="button"
             class="codex-small-text-button"
             :disabled="api.loginPending.value"
             @click="api.loginWithDeviceCode()"
           >
             {{ t('codexPanel.loginDeviceCode') }}
           </button>
         </div>
       </div>

       <!-- Device code info -->
       <div v-if="api.deviceCodeInfo.value" class="codex-device-code">
         <p>{{ t('codexPanel.deviceCodeInstruction') }}</p>
         <div class="codex-device-code-url">
           <a :href="api.deviceCodeInfo.value.verificationUrl" target="_blank">{{ api.deviceCodeInfo.value.verificationUrl }}</a>
         </div>
         <div class="codex-device-code-value">{{ api.deviceCodeInfo.value.userCode }}</div>
       </div>

       <!-- Login error -->
       <p v-if="api.loginError.value" class="codex-error">{{ api.loginError.value }}</p>

       <!-- Login pending -->
       <div v-if="api.loginPending.value" class="codex-login-pending">
         {{ t('codexPanel.loginPending') }}
       </div>
     </div>

     <p v-if="api.errorMessage.value" class="codex-error" role="alert">
       {{ api.errorMessage.value }}
     </p>

    <div class="codex-panel-body">
      <aside class="codex-thread-list" :aria-label="t('codexPanel.threads')">
        <div class="codex-section-title">
          <span>{{ t('codexPanel.threads') }}</span>
          <div class="codex-thread-tools">
            <button
              type="button"
              class="codex-small-button"
              :class="{ active: showArchived }"
              :disabled="!api.connected.value || showHidden"
              :title="t('codexPanel.showArchived')"
              @click="toggleArchived()"
            >
              <Icon icon="mdi:archive" width="16" />
            </button>
            <button
              type="button"
              class="codex-small-button"
              :class="{ active: showHidden }"
              :disabled="!api.connected.value || showArchived"
              :title="t('codexPanel.showHidden')"
              @click="toggleHidden()"
            >
              <Icon icon="mdi:eye" width="16" />
            </button>
            <button
              type="button"
              class="codex-small-button"
              :disabled="!api.connected.value"
              :title="t('codexPanel.refreshThreads')"
              @click="refreshThreads()"
            >
              <Icon icon="mdi:refresh" width="16" />
            </button>
          </div>
        </div>
        <button
          type="button"
          class="codex-thread-new"
          :disabled="!api.connected.value || showArchived"
          @click="startThread()"
        >
          {{ t('codexPanel.newThread') }}
        </button>
        <div v-if="displayThreads.length === 0" class="codex-empty">
          {{
            api.connected.value
              ? showHidden
                ? t('codexPanel.noHiddenThreads')
                : t('codexPanel.noThreads')
              : t('codexPanel.connectToLoad')
          }}
        </div>
        <div
          v-for="thread in displayThreads"
          :key="thread.id"
          class="codex-thread-item"
          :class="{ active: thread.id === api.activeThreadId.value }"
        >
          <div class="codex-thread-row">
            <button
              type="button"
              class="codex-thread-select"
              :disabled="api.loadingThread.value"
              :title="thread.id"
              @click="selectThread(thread.id)"
            >
              <span class="codex-thread-title">
                <Icon
                  v-if="api.pinnedThreadIds.value.has(thread.id)"
                  icon="mdi:pin"
                  width="12"
                  class="codex-pin-icon"
                />
                {{ thread.name || thread.preview || thread.id }}
              </span>
              <small class="codex-thread-cwd" v-if="thread.cwd" :title="thread.cwd">
                <Icon icon="mdi:folder-outline" width="10" />
                {{ thread.cwd }}
              </small>
              <small v-else>{{ thread.id }}</small>
            </button>
            <div class="codex-thread-actions">
              <button
                v-if="!showArchived && !showHidden"
                type="button"
                class="codex-icon-button"
                :disabled="!api.connected.value"
                :title="
                  api.pinnedThreadIds.value.has(thread.id)
                    ? t('codexPanel.unpin')
                    : t('codexPanel.pin')
                "
                @click="togglePin(thread.id)"
              >
                <Icon
                  :icon="api.pinnedThreadIds.value.has(thread.id) ? 'mdi:pin-off' : 'mdi:pin'"
                  width="14"
                />
              </button>
              <button
                v-if="!showArchived && !showHidden"
                type="button"
                class="codex-icon-button"
                :disabled="!api.connected.value"
                :title="t('codexPanel.hide')"
                @click="api.hideThread(thread.id)"
              >
                <Icon icon="mdi:eye-off" width="14" />
              </button>
              <button
                v-if="showHidden"
                type="button"
                class="codex-small-text-button"
                :disabled="!api.connected.value"
                @click="api.unhideThread(thread.id)"
              >
                {{ t('codexPanel.unhide') }}
              </button>
              <button
                v-if="showArchived"
                type="button"
                class="codex-small-text-button"
                :disabled="!api.connected.value"
                @click="unarchiveThread(thread.id)"
              >
                {{ t('codexPanel.unarchive') }}
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main class="codex-output" aria-live="polite">
        <div v-if="api.loadingThread.value" class="codex-loading-thread">
          {{ t('codexPanel.loadingThread') }}
        </div>
        <div v-if="api.activeThreadId.value" class="codex-active-thread-tools">
          <label class="codex-rename-field">
            <span>{{ t('codexPanel.threadName') }}</span>
            <input
              v-model="threadName"
              class="codex-input"
              type="text"
              :disabled="!api.connected.value"
              :placeholder="t('codexPanel.renamePlaceholder')"
            />
          </label>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value"
            @click="renameThread()"
          >
            {{ t('codexPanel.rename') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value"
            @click="unsubscribeActiveThread()"
          >
            {{ t('codexPanel.unsubscribe') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value || !api.activeTurn.value"
            @click="interruptTurn()"
          >
            {{ t('codexPanel.interrupt') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value"
            :title="t('codexPanel.fork')"
            @click="forkActiveThread()"
          >
            {{ t('codexPanel.fork') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value"
            :title="t('codexPanel.rollbackTurns')"
            @click="rollbackActiveThread()"
          >
            {{ t('codexPanel.rollback') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value"
            @click="togglePin(api.activeThreadId.value)"
          >
            {{
              api.pinnedThreadIds.value.has(api.activeThreadId.value)
                ? t('codexPanel.unpin')
                : t('codexPanel.pin')
            }}
          </button>
          <button
            type="button"
            class="codex-small-text-button danger"
            :disabled="!api.connected.value"
            @click="archiveActiveThread()"
          >
            {{ t('codexPanel.archive') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value || !api.activeThreadId.value"
            @click="api.showShellCommand.value = true"
          >
            {{ t('codexPanel.shellCommand') }}
          </button>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value || !api.activeThreadId.value"
            @click="compactActiveThread()"
          >
            {{ t('codexPanel.compactThread') }}
          </button>
          <span v-if="api.activeTurn.value" class="codex-turn-status">
            {{ t('codexPanel.turnStatus') }}
            {{ api.activeTurn.value.status || t('codexPanel.turnActive') }}
          </span>
        </div>

        <!-- Tab navigation -->
        <div v-if="api.activeThreadId.value" class="codex-tab-bar">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            type="button"
            class="codex-tab-button"
            :class="{ 'is-active': activeTab === tab.key }"
            @click="activeTab = tab.key"
          >
            {{ tab.label() }}
          </button>
        </div>

        <div v-if="api.serverRequests.value.length > 0" class="codex-approval-list">
          <section
            v-for="request in api.serverRequests.value"
            :key="String(request.id)"
            class="codex-approval-card"
            :class="'is-' + request.method.replace(/\//g, '-')"
          >
            <!-- 审批类型头部 -->
            <div class="codex-approval-header">
              <Icon
                :icon="getApprovalIcon(request.method)"
                width="16"
                class="codex-approval-icon"
              />
              <span class="codex-approval-type">{{ getApprovalTypeLabel(request.method) }}</span>
              <span class="codex-approval-scope">
                {{ request.threadId }} · {{ request.turnId }}
              </span>
            </div>

            <!-- 命令执行详情 -->
            <div v-if="request.context.command" class="codex-approval-detail">
              <div class="codex-approval-label">{{ t('codexPanel.approvalCommand') }}</div>
              <code class="codex-approval-command">{{ request.context.command }}</code>
            </div>

            <!-- CWD -->
            <div v-if="request.context.cwd" class="codex-approval-detail">
              <div class="codex-approval-label">{{ t('codexPanel.approvalCwd') }}</div>
              <div class="codex-approval-value">{{ request.context.cwd }}</div>
            </div>

            <!-- 原因 -->
            <div v-if="request.context.reason" class="codex-approval-detail">
              <div class="codex-approval-label">{{ t('codexPanel.approvalReason') }}</div>
              <div class="codex-approval-value">{{ request.context.reason }}</div>
            </div>

            <!-- 网络访问详情 -->
            <div v-if="request.context.host" class="codex-approval-detail is-network">
              <div class="codex-approval-label">{{ t('codexPanel.approvalNetworkRequest') }}</div>
              <div class="codex-approval-value">
                <span>{{ t('codexPanel.approvalHost') }}: {{ request.context.host }}</span>
                <span v-if="request.context.protocol"> · {{ t('codexPanel.approvalProtocol') }}: {{ request.context.protocol }}</span>
              </div>
            </div>

            <!-- 执行策略修正 -->
            <div v-if="request.context.proposedAmendment?.length" class="codex-approval-detail">
              <div class="codex-approval-label">{{ t('codexPanel.approvalExecpolicyAmendment') }}</div>
              <pre class="codex-approval-amendment">{{ request.context.proposedAmendment.join('\n') }}</pre>
            </div>

            <!-- 文件变更 -->
            <div v-if="request.context.fileChanges?.length" class="codex-approval-detail">
              <div class="codex-approval-label">{{ t('codexPanel.approvalFileChanges') }}</div>
              <div class="codex-approval-file-list">
                <div
                  v-for="change in request.context.fileChanges"
                  :key="change.path"
                  class="codex-approval-file-item"
                >
                  <span :class="'kind-' + change.kind">{{ change.kind }}</span>
                  <span>{{ change.path }}</span>
                </div>
              </div>
            </div>

            <!-- 决策按钮 -->
            <div class="codex-approval-actions">
              <button
                v-for="decision in request.availableDecisions"
                :key="decision"
                type="button"
                class="codex-approval-button"
                :class="'is-' + decision"
                @click="resolveRequest(request.id, decision)"
              >
                {{ getDecisionLabel(decision) }}
              </button>
            </div>
          </section>
        </div>

        <!-- Tool User Input Modal -->
        <div v-if="api.toolUserInputRequests.value.length > 0" class="codex-tool-input-modal">
          <section
            v-for="request in api.toolUserInputRequests.value"
            :key="String(request.requestId)"
            class="codex-tool-input-card"
          >
            <div class="codex-tool-input-header">
              <Icon icon="mdi:tools" width="16" />
              <span>{{ t('codexPanel.toolUserInputTitle') }}</span>
            </div>
            <div
              v-for="question in request.questions"
              :key="question.id"
              class="codex-tool-input-question"
            >
              <label>{{ question.text }}</label>
              <input
                v-model="toolInputResponses[request.requestId + '_' + question.id]"
                class="codex-input"
                type="text"
                :placeholder="question.isOther ? t('codexPanel.toolUserInputOther') : ''"
              />
            </div>
            <div class="codex-tool-input-actions">
              <button
                type="button"
                class="codex-primary-button"
                @click="submitToolUserInput(request.requestId, request.questions)"
              >
                {{ t('common.submit') }}
              </button>
              <button
                type="button"
                class="codex-small-text-button danger"
                @click="declineToolUserInput(request.requestId)"
              >
                {{ t('common.cancel') }}
              </button>
            </div>
          </section>
        </div>

        <!-- Dynamic Tool Call Modal -->
        <div v-if="api.dynamicToolCalls.value.length > 0" class="codex-dynamic-tool-modal">
          <section
            v-for="call in api.dynamicToolCalls.value"
            :key="String(call.requestId)"
            class="codex-dynamic-tool-card"
          >
            <div class="codex-dynamic-tool-header">
              <Icon icon="mdi:lightning-bolt" width="16" />
              <span>{{ t('codexPanel.dynamicToolCallTitle') }}: {{ call.toolName }}</span>
            </div>
            <pre class="codex-dynamic-tool-args">{{ JSON.stringify(call.arguments, null, 2) }}</pre>
            <div class="codex-dynamic-tool-actions">
              <button
                type="button"
                class="codex-primary-button"
                @click="acceptDynamicToolCall(call.requestId)"
              >
                {{ t('common.accept') }}
              </button>
              <button
                type="button"
                class="codex-small-text-button danger"
                @click="declineDynamicToolCall(call.requestId)"
              >
                {{ t('common.decline') }}
              </button>
            </div>
          </section>
        </div>

        <template v-if="activeTab === 'chat'">
        <div
          v-if="api.transcript.value.length === 0"
          class="codex-empty codex-output-empty"
        >
          {{ t('codexPanel.noTranscript') }}
        </div>
        <article
          v-for="entry in api.transcript.value"
          :key="entry.id"
          class="codex-message"
          :class="[`is-${entry.role}`, getEntryTypeClass(entry.text)]"
        >
          <div class="codex-message-role">
            {{ getEntryLabel(entry) }}
          </div>
          <div class="codex-message-content">
            <!-- Command execution -->
            <template v-if="entry.text.startsWith('$ ')">
              <div class="codex-command-block">
                <code>{{ entry.text.split('\n')[0] }}</code>
              </div>
              <pre v-if="entry.text.includes('\n')">{{ entry.text.slice(entry.text.indexOf('\n') + 1) }}</pre>
            </template>

            <!-- File changes -->
            <template v-else-if="entry.text.startsWith('File changes')">
              <div class="codex-file-changes">
                <pre>{{ entry.text }}</pre>
              </div>
            </template>

            <!-- Review mode -->
            <template v-else-if="entry.text.startsWith('Review')">
              <div class="codex-review-block">
                <div class="codex-review-label">{{ t('codexPanel.transcriptReviewMode') }}</div>
                <pre>{{ entry.text.replace(/^Review[^:]*: ?/, '') }}</pre>
              </div>
            </template>

            <!-- Reasoning -->
            <template v-else-if="entry.text.startsWith('Reasoning')">
              <div class="codex-reasoning-block">
                <div class="codex-reasoning-label">{{ t('codexPanel.transcriptReasoning') }}</div>
                <pre>{{ entry.text.replace(/^Reasoning: ?/, '') }}</pre>
              </div>
            </template>

            <!-- Default -->
            <template v-else>
              <pre>{{ entry.text }}</pre>
            </template>
          </div>
        </article>

        <div v-if="api.previewFilePath.value" class="codex-file-preview">
          <div class="codex-file-preview-header">
            <span>{{ api.previewFilePath.value }}</span>
            <button
              type="button"
              class="codex-icon-button"
              :title="t('codexPanel.closePreview')"
              @click="api.clearPreview()"
            >
              <Icon icon="mdi:close" width="14" />
            </button>
          </div>
          <pre class="codex-file-preview-body">{{ api.previewFileContent.value }}</pre>
        </div>

        <div v-if="api.activeThreadId.value" class="codex-sandbox">
          <!-- 工具栏：路径输入 + 按钮 -->
          <div class="codex-sandbox-toolbar">
            <input
              v-model="api.sandboxPath.value"
              class="codex-input codex-sandbox-input"
              type="text"
              :disabled="!api.connected.value"
              :placeholder="t('codexPanel.fsPathPlaceholder')"
              @keydown.enter.prevent="api.openAsSandbox(api.sandboxPath.value)"
              @keydown.tab.prevent="handleSuggestionKeydown"
              @keydown.down.prevent="handleSuggestionKeydown"
              @keydown.up.prevent="handleSuggestionKeydown"
              @keydown.escape.prevent="handleSuggestionKeydown"
              @input="selectedSuggestionIndex = -1; api.updatePathSuggestions(api.sandboxPath.value)"
              @blur="api.hidePathSuggestions()"
            />
            <ul
              v-if="api.fsShowSuggestions.value && api.fsSuggestions.value.length > 0"
              class="codex-fs-suggestions"
            >
              <li
                v-for="(suggestion, index) in api.fsSuggestions.value"
                :key="suggestion"
                :class="{ 'is-selected': index === selectedSuggestionIndex }"
                @mousedown.prevent="selectSuggestion(suggestion)"
              >
                <Icon icon="mdi:folder" width="12" />
                {{ suggestion }}
              </li>
            </ul>
            <button
              type="button"
              class="codex-small-button"
              :disabled="!api.connected.value || !api.sandboxPath.value"
              :title="t('codexPanel.sandboxBrowse')"
              @click="api.openAsSandbox(api.sandboxPath.value)"
            >
              <Icon icon="mdi:folder-open" width="14" />
            </button>
            <button
              type="button"
              class="codex-small-button"
              :disabled="!api.connected.value || !api.sandboxPath.value"
              :title="t('codexPanel.fsNewThreadHere')"
              @click="createThreadInSandbox()"
            >
              <Icon icon="mdi:plus" width="14" />
            </button>
          </div>

          <!-- 面包屑导航 -->
          <div v-if="api.fsBreadcrumbs.value.length > 0" class="codex-breadcrumbs">
            <button
              v-for="crumb in api.fsBreadcrumbs.value"
              :key="crumb.path"
              type="button"
              class="codex-breadcrumb-item"
              :disabled="!api.connected.value || api.fsLoading.value"
              @click="api.navigateToPath(crumb.path)"
            >
              {{ crumb.name === '/' ? t('codexPanel.fsBreadcrumbRoot') : crumb.name }}
            </button>
          </div>

          <CodexFsManager :api="api" />

          <!-- 上级目录按钮 -->
          <button
            v-if="api.fsCwd.value && api.fsCwd.value !== '/'"
            type="button"
            class="codex-sandbox-item codex-parent-dir"
            :disabled="!api.connected.value || api.fsLoading.value"
            @click="api.navigateToParent()"
          >
            <Icon icon="mdi:arrow-up" width="14" />
            <span>{{ t('codexPanel.fsParentDirectory') }}</span>
          </button>

          <!-- 加载和错误状态 -->
          <div v-if="api.fsLoading.value" class="codex-empty">{{ t('common.loading') }}</div>
          <div v-else-if="api.fsError.value" class="codex-error">{{ api.fsError.value }}</div>
          <div v-else-if="api.fsEntries.value.length === 0" class="codex-empty">{{ t('codexPanel.sandboxEmpty') }}</div>

          <!-- 文件列表 -->
          <div v-else class="codex-sandbox-list">
            <button
              v-for="entry in api.fsEntries.value"
              :key="entry.fileName"
              type="button"
              class="codex-sandbox-item"
              :class="{ 'is-directory': entry.isDirectory }"
              @click="handleFsEntryClick(entry)"
            >
              <Icon
                :icon="entry.isDirectory ? 'mdi:folder' : 'mdi:file-document-outline'"
                width="14"
                :class="entry.isDirectory ? 'codex-dir-icon' : 'codex-file-icon'"
              />
              <span>{{ entry.fileName }}</span>
            </button>
          </div>
        </div>
        </template>

        <!-- Shell Command Input -->
        <div v-if="api.showShellCommand.value" class="codex-shell-command">
          <div class="codex-shell-command-header">
            <span>{{ t('codexPanel.shellCommand') }}</span>
            <button
              type="button"
              class="codex-icon-button"
              :title="t('common.close')"
              @click="api.showShellCommand.value = false"
            >
              <Icon icon="mdi:close" width="14" />
            </button>
          </div>
          <input
            v-model="api.shellCommandInput.value"
            class="codex-input"
            type="text"
            :placeholder="t('codexPanel.shellCommandPlaceholder')"
            @keydown.enter.prevent="runShellCommand()"
          />
          <button
            type="button"
            class="codex-primary-button"
            :disabled="!api.connected.value || !api.shellCommandInput.value.trim()"
            @click="runShellCommand()"
          >
            {{ t('codexPanel.shellCommandRun') }}
          </button>
        </div>

        <!-- Other tab contents -->
        <CodexModelManager v-if="activeTab === 'models'" :api="api" />
        <CodexSkillsManager v-if="activeTab === 'skills'" :api="api" />
        <CodexPluginManager v-if="activeTab === 'plugins'" :api="api" />
        <CodexMcpServerManager v-if="activeTab === 'mcp'" :api="api" />
        <CodexConfigViewer v-if="activeTab === 'config'" :api="api" />
        <CodexAppManager v-if="activeTab === 'apps'" :api="api" />
        <CodexExperimentalFeatureManager v-if="activeTab === 'experimentalFeatures'" :api="api" />
        <CodexCollaborationModeManager v-if="activeTab === 'collaborationModes'" :api="api" />
        <CodexExternalAgentConfig v-if="activeTab === 'externalAgentConfig'" :api="api" />
        <CodexFeedbackUploader v-if="activeTab === 'feedback'" :api="api" />

        <details v-if="api.events.value.length > 0" class="codex-events">
          <summary>
            {{ t('codexPanel.events') }} · {{ api.events.value.length }}
          </summary>
          <ol>
            <li v-for="event in recentEvents" :key="event.id">
              {{ event.method }}
            </li>
          </ol>
         </details>
       </main>
     </div>

     <!-- Rate limits display -->
     <div v-if="api.accountRateLimits.value" class="codex-rate-limits">
       <div class="codex-rate-limit-header">
         <span class="codex-rate-limit-title">{{ t('codexPanel.rateLimits') }}</span>
         <button
           type="button"
           class="codex-small-button"
           :title="t('codexPanel.refreshRateLimits')"
           @click="api.refreshAccountRateLimits()"
         >
           <Icon icon="mdi:refresh" width="14" />
         </button>
       </div>
       <div class="codex-rate-limit-bar">
         <div
           class="codex-rate-limit-fill"
           :style="{ width: api.accountRateLimits.value.primary.usedPercent + '%' }"
           :class="{ 'is-high': api.accountRateLimits.value.primary.usedPercent > 80 }"
         ></div>
       </div>
       <div class="codex-rate-limit-info">
         {{ api.accountRateLimits.value.primary.usedPercent }}% used ·
         {{ api.accountRateLimits.value.primary.windowDurationMins }}min window
       </div>
     </div>

     <form class="codex-prompt" @submit.prevent="sendPrompt">
      <div v-if="api.selectedModel.value" class="codex-model-selector">
        <span class="codex-model-selector-label">{{ api.selectedModel.value }}</span>
        <button
          type="button"
          class="codex-small-text-button"
          @click="activeTab = 'models'"
        >
          {{ t('codexPanel.modelsTitle') }}
        </button>
      </div>
      <textarea
        v-model="promptText"
        class="codex-prompt-input"
        rows="3"
        :disabled="!api.connected.value || api.pending.value"
        :placeholder="t('codexPanel.promptPlaceholder')"
        @keydown.enter.exact.prevent="sendPrompt"
      ></textarea>
      <button
        v-if="api.activeTurn.value?.status === 'inProgress'"
        type="button"
        class="codex-primary-button codex-send-button"
        :disabled="!api.connected.value || promptText.trim().length === 0"
        @click.prevent="steerTurn()"
      >
        {{ t('codexPanel.steerTurn') }}
      </button>
      <button
        v-else
        type="submit"
        class="codex-primary-button codex-send-button"
        :disabled="
          !api.connected.value || api.pending.value || promptText.trim().length === 0
        "
      >
        {{ api.pending.value ? t('codexPanel.sending') : t('codexPanel.send') }}
      </button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { CodexJsonRpcId } from '../backends/codex/jsonRpcClient';
import type { CodexFsDirectoryEntry } from '../backends/codex/codexAdapter';
import type { CodexTranscriptEntry } from '../composables/useCodexApi';
import { useCodexApi } from '../composables/useCodexApi';
import CodexModelManager from './codex/CodexModelManager.vue';
import CodexSkillsManager from './codex/CodexSkillsManager.vue';
import CodexPluginManager from './codex/CodexPluginManager.vue';
import CodexMcpServerManager from './codex/CodexMcpServerManager.vue';
import CodexConfigViewer from './codex/CodexConfigViewer.vue';
import CodexFsManager from './codex/CodexFsManager.vue';
import CodexAppManager from './codex/CodexAppManager.vue';
import CodexExperimentalFeatureManager from './codex/CodexExperimentalFeatureManager.vue';
import CodexCollaborationModeManager from './codex/CodexCollaborationModeManager.vue';
import CodexExternalAgentConfig from './codex/CodexExternalAgentConfig.vue';
import CodexFeedbackUploader from './codex/CodexFeedbackUploader.vue';

 const { t } = useI18n();
 const api = useCodexApi();
 const promptText = ref('');
 const threadName = ref('');
 const showArchived = ref(false);
 const showHidden = ref(false);
 const showLoginPanel = ref(false);
  const apiKeyInput = ref('');
  const selectedSuggestionIndex = ref(-1);
  const activeTab = ref('chat');
  const toolInputResponses = ref<Record<string, string>>({});
  const recentEvents = computed(() => api.events.value.slice(-8).reverse());

  const tabs = [
    { key: 'chat', label: () => t('codexPanel.tabChat') },
    { key: 'models', label: () => t('codexPanel.tabModels') },
    { key: 'skills', label: () => t('codexPanel.tabSkills') },
    { key: 'plugins', label: () => t('codexPanel.tabPlugins') },
    { key: 'mcp', label: () => t('codexPanel.tabMcp') },
    { key: 'config', label: () => t('codexPanel.tabConfig') },
    { key: 'apps', label: () => t('codexPanel.tabApps') },
    { key: 'experimentalFeatures', label: () => t('codexPanel.tabExperimentalFeatures') },
    { key: 'collaborationModes', label: () => t('codexPanel.tabCollaborationModes') },
    { key: 'externalAgentConfig', label: () => t('codexPanel.tabExternalAgentConfig') },
    { key: 'feedback', label: () => t('codexPanel.tabFeedback') },
  ];
const activeThread = computed(
  () =>
    api.threads.value.find((thread) => thread.id === api.activeThreadId.value) ??
    null,
);

const displayThreads = computed(() => {
  if (showHidden.value) return api.threads.value.filter((thread) => api.hiddenThreadIds.value.has(thread.id));
  if (showArchived.value) return api.threads.value;
  return api.visibleThreads.value;
});

watch(activeThread, (thread) => {
  threadName.value = thread?.name ?? '';
});

function getApprovalIcon(method: string): string {
  if (method.includes('commandExecution')) return 'mdi:console';
  if (method.includes('fileChange')) return 'mdi:file-edit';
  if (method.includes('tool')) return 'mdi:tools';
  return 'mdi:help-circle';
}

function getApprovalTypeLabel(method: string): string {
  if (method.includes('commandExecution')) return t('codexPanel.approvalTypeCommandExecution');
  if (method.includes('fileChange')) return t('codexPanel.approvalTypeFileChange');
  if (method.includes('network')) return t('codexPanel.approvalTypeNetworkAccess');
  return method;
}

function getDecisionLabel(decision: string): string {
  const labels: Record<string, string> = {
    accept: t('codexPanel.approvalDecisionAccept'),
    acceptForSession: t('codexPanel.approvalDecisionAcceptForSession'),
    decline: t('codexPanel.approvalDecisionDecline'),
    cancel: t('codexPanel.approvalDecisionCancel'),
    acceptWithExecpolicyAmendment: t('codexPanel.approvalDecisionAmend'),
  };
  return labels[decision] || decision;
}

async function connect() {
  await api.connect(api.url.value);
}

async function refreshThreads() {
  await api.refreshThreads(showArchived.value ? { archived: true } : {});
}

async function toggleArchived() {
  showArchived.value = !showArchived.value;
  if (showArchived.value) showHidden.value = false;
  await refreshThreads();
}

async function toggleHidden() {
  showHidden.value = !showHidden.value;
  if (showHidden.value) showArchived.value = false;
  await refreshThreads();
}

async function startThread() {
  showArchived.value = false;
  showHidden.value = false;
  await api.startThread();
}

async function selectThread(threadId: string) {
  await api.selectThread(threadId);
}

async function renameThread() {
  if (!api.activeThreadId.value) return;
  await api.setThreadName(api.activeThreadId.value, threadName.value);
}

async function archiveActiveThread() {
  if (!api.activeThreadId.value) return;
  await api.archiveThread(api.activeThreadId.value);
}

async function unarchiveThread(threadId: string) {
  showArchived.value = false;
  await api.unarchiveThread(threadId);
}

async function unsubscribeActiveThread() {
  await api.unsubscribeThread();
}

async function interruptTurn() {
  await api.interruptActiveTurn();
}

async function forkActiveThread() {
  if (!api.activeThreadId.value) return;
  await api.forkThread(api.activeThreadId.value);
}

async function rollbackActiveThread() {
  if (!api.activeThreadId.value) return;
  await api.rollbackThread(api.activeThreadId.value, 1);
}

function togglePin(threadId: string) {
  if (api.pinnedThreadIds.value.has(threadId)) {
    api.unpinThread(threadId);
  } else {
    api.pinThread(threadId);
  }
}

function resolveRequest(id: CodexJsonRpcId, decision: string) {
  api.resolveServerRequest(id, decision);
}

async function submitToolUserInput(
  requestId: CodexJsonRpcId,
  questions: Array<{ id: string; text: string; isOther?: boolean }>,
) {
  const responses = questions.map((q) => ({
    questionId: q.id,
    response: toolInputResponses.value[`${String(requestId)}_${q.id}`] ?? '',
  }));
  await api.respondToToolUserInput(requestId, responses);
  for (const q of questions) {
    delete toolInputResponses.value[`${String(requestId)}_${q.id}`];
  }
}

async function declineToolUserInput(requestId: CodexJsonRpcId) {
  await api.respondToToolUserInput(requestId, []);
}

async function acceptDynamicToolCall(requestId: CodexJsonRpcId) {
  await api.respondToDynamicToolCall(requestId, []);
}

async function declineDynamicToolCall(requestId: CodexJsonRpcId) {
  await api.respondToDynamicToolCall(requestId, []);
}

async function sendPrompt() {
  const text = promptText.value.trim();
  if (!text) return;
  promptText.value = '';
  await api.sendPrompt(text);
}

async function steerTurn() {
  const text = promptText.value.trim();
  if (!text || !api.activeTurn.value?.id) return;
  promptText.value = '';
  await api.steerTurn(api.activeTurn.value.id, text);
}

async function runShellCommand() {
  const command = api.shellCommandInput.value.trim();
  if (!command || !api.activeThreadId.value) return;
  api.shellCommandInput.value = '';
  api.showShellCommand.value = false;
  await api.runThreadShellCommand(api.activeThreadId.value, command);
}

async function compactActiveThread() {
  if (!api.activeThreadId.value) return;
  if (!confirm(t('codexPanel.compactThreadConfirm'))) return;
  await api.startThreadCompaction(api.activeThreadId.value);
}

async function createThreadInSandbox() {
  if (!api.sandboxPath.value) return;
  await api.createThreadInSandbox();
  api.sandboxPath.value = '';
}

async function selectSuggestion(suggestion: string) {
  api.sandboxPath.value = suggestion;
  selectedSuggestionIndex.value = -1;
  api.hidePathSuggestions();
  await api.openAsSandbox(suggestion);
}

function handleSuggestionKeydown(event: KeyboardEvent) {
  const suggestions = api.fsSuggestions.value;
  if (suggestions.length === 0) return;

  if (event.key === 'Tab') {
    event.preventDefault();
    if (selectedSuggestionIndex.value >= 0) {
      selectSuggestion(suggestions[selectedSuggestionIndex.value]);
    } else if (suggestions[0]) {
      selectSuggestion(suggestions[0]);
    }
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    selectedSuggestionIndex.value =
      selectedSuggestionIndex.value < suggestions.length - 1
        ? selectedSuggestionIndex.value + 1
        : 0;
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    selectedSuggestionIndex.value =
      selectedSuggestionIndex.value > 0
        ? selectedSuggestionIndex.value - 1
        : suggestions.length - 1;
    return;
  }

  if (event.key === 'Escape') {
    selectedSuggestionIndex.value = -1;
    api.hidePathSuggestions();
  }
}

function joinFsPath(base: string, name: string): string {
  if (!base || base === '/') return `/${name}`;
  if (base.endsWith('/')) return `${base}${name}`;
  return `${base}/${name}`;
}

async function handleFsEntryClick(entry: CodexFsDirectoryEntry) {
  const path = joinFsPath(api.fsCwd.value, entry.fileName);
  if (entry.isDirectory) {
    await api.readDirectory(path);
  } else {
    await api.readFile(path);
  }
}

function getEntryTypeClass(text: string): string {
  if (text.startsWith('$ ')) return 'is-command';
  if (text.startsWith('File changes')) return 'is-file-change';
  if (text.startsWith('Review')) return 'is-review';
  if (text.startsWith('Reasoning')) return 'is-reasoning';
  if (text.startsWith('Context compaction')) return 'is-compaction';
  if (text.startsWith('Web search')) return 'is-web-search';
  if (text.startsWith('Tool call')) return 'is-tool-call';
  if (text.startsWith('Image')) return 'is-image';
  return '';
}

function getEntryLabel(entry: CodexTranscriptEntry): string {
  if (entry.role === 'user') return t('codexPanel.messageUser');
  if (entry.role === 'assistant') return t('codexPanel.messageAssistant');
  // System messages with specific types
  const text = entry.text;
  if (text.startsWith('$ ')) return t('codexPanel.transcriptCommandExecution');
  if (text.startsWith('File changes')) return t('codexPanel.transcriptFileChange');
  if (text.startsWith('Review')) return t('codexPanel.transcriptReviewMode');
  if (text.startsWith('Reasoning')) return t('codexPanel.transcriptReasoning');
  if (text.startsWith('Context compaction')) return t('codexPanel.transcriptCompaction');
  if (text.startsWith('Web search')) return t('codexPanel.transcriptWebSearch');
  if (text.startsWith('Tool call')) return t('codexPanel.transcriptToolCall');
  if (text.startsWith('Image')) return t('codexPanel.transcriptImage');
  return t('codexPanel.messageSystem');
}
</script>

<style scoped>
.codex-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  color: var(--theme-floating-text, #e2e8f0);
  background: var(--theme-floating-surface-base, rgba(15, 23, 42, 0.96));
  font-family: var(--app-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.codex-panel-header,
.codex-prompt {
  display: flex;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
}

.codex-prompt {
  border-top: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-bottom: 0;
}

.codex-url-field,
.codex-token-field {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-token-field {
  flex: 0 0 160px;
}

.codex-input,
.codex-prompt-input {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  appearance: none;
  outline: none;
  background: var(--theme-input-bg, rgba(2, 6, 23, 0.65));
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-input {
  height: 34px;
  padding: 0 10px;
}

.codex-prompt-input {
  flex: 1 1 auto;
  resize: none;
  padding: 10px;
  line-height: 1.45;
}

.codex-primary-button,
.codex-small-button,
.codex-small-text-button,
.codex-thread-new,
.codex-thread-select,
.codex-thread-action,
.codex-icon-button {
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  appearance: none;
  outline: none;
  color: var(--theme-text-primary, #e2e8f0);
  background: var(--theme-button-bg, rgba(30, 41, 59, 0.82));
  cursor: pointer;
}

.codex-primary-button {
  align-self: end;
  height: 34px;
  padding: 0 14px;
  font-weight: 700;
  background: var(--theme-accent-primary, #2563eb);
  border-color: transparent;
}

.codex-send-button {
  align-self: stretch;
  height: auto;
}

button:disabled,
textarea:disabled,
input:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.codex-error {
  margin: 0;
  padding: 8px 12px;
  color: var(--theme-status-error, #f87171);
  background: rgba(127, 29, 29, 0.22);
  border-bottom: 1px solid rgba(248, 113, 113, 0.25);
}

.codex-panel-body {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  flex: 1 1 auto;
  min-height: 0;
}

.codex-thread-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 12px;
  overflow: auto;
  border-right: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
}

.codex-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--theme-text-muted, #94a3b8);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.codex-small-button {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.codex-icon-button {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
}

.codex-small-button.active,
.codex-small-text-button.active {
  border-color: var(--theme-accent-primary, #60a5fa);
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-small-text-button {
  min-height: 30px;
  padding: 0 10px;
  font-size: 12px;
}

.codex-small-text-button.danger {
  color: var(--theme-status-error, #f87171);
}

.codex-thread-tools {
  display: flex;
  gap: 6px;
}

.codex-thread-new {
  min-height: 32px;
  font-weight: 700;
}

.codex-thread-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.codex-thread-item.active {
  border-radius: 10px;
  outline: 1px solid var(--theme-accent-primary, #60a5fa);
  outline-offset: 0;
}

.codex-thread-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.codex-thread-select {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 9px;
  text-align: left;
}

.codex-thread-item.active .codex-thread-select {
  background: rgba(37, 99, 235, 0.18);
}

  .codex-thread-actions {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
    padding-right: 4px;
  }

.codex-thread-action {
  min-height: 26px;
  font-size: 11px;
}

.codex-thread-title {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-pin-icon {
  flex-shrink: 0;
  color: var(--theme-accent-primary, #60a5fa);
}

  .codex-thread-item small {
  overflow: hidden;
  color: var(--theme-text-muted, #94a3b8);
  text-overflow: ellipsis;
  white-space: nowrap;
}

  .codex-thread-cwd {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--theme-accent-primary, #60a5fa);
  font-size: 10px;
}

.codex-output {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  padding: 14px;
  overflow: auto;
}

.codex-tab-bar {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-bottom: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  overflow-x: auto;
  flex-shrink: 0;
}

.codex-tab-button {
  padding: 6px 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.codex-tab-button:hover {
  background: rgba(148, 163, 184, 0.12);
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-tab-button.is-active {
  border-color: var(--theme-accent-primary, #60a5fa);
  background: rgba(37, 99, 235, 0.15);
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-active-thread-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px;
}

.codex-approval-list {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 10px;
}

.codex-approval-card {
  flex: 1 1 320px;
  padding: 12px 14px;
  border: 1px solid rgba(251, 191, 36, 0.32);
  border-radius: 12px;
  background: rgba(120, 53, 15, 0.2);
}

.codex-approval-card.is-item-commandExecution-requestApproval {
  border-color: rgba(251, 191, 36, 0.4);
  background: rgba(120, 53, 15, 0.25);
}

.codex-approval-card.is-item-fileChange-requestApproval {
  border-color: rgba(74, 222, 128, 0.4);
  background: rgba(6, 78, 59, 0.2);
}

.codex-approval-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.codex-approval-icon {
  flex-shrink: 0;
  color: var(--theme-accent-primary, #fbbf24);
}

.codex-approval-type {
  font-weight: 700;
  font-size: 13px;
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-approval-scope {
  margin-left: auto;
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-approval-detail {
  margin-top: 8px;
}

.codex-approval-detail.is-network {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(37, 99, 235, 0.12);
}

.codex-approval-label {
  font-size: 10px;
  color: var(--theme-text-muted, #94a3b8);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 3px;
}

.codex-approval-command {
  display: block;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(2, 6, 23, 0.5);
  font-family: var(--app-monospace-font-family, ui-monospace, monospace);
  font-size: 12px;
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-approval-value {
  font-size: 12px;
  color: var(--theme-text-primary, #e2e8f0);
  word-break: break-word;
}

.codex-approval-amendment {
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(2, 6, 23, 0.4);
  font-size: 11px;
  color: var(--theme-text-primary, #e2e8f0);
  white-space: pre-wrap;
}

.codex-approval-file-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.codex-approval-file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.codex-approval-file-item span:first-child {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(74, 222, 128, 0.2);
  color: var(--theme-status-success, #4ade80);
  font-size: 10px;
  text-transform: uppercase;
}

.codex-approval-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid rgba(148, 163, 184, 0.12);
}

.codex-approval-button {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 8px;
  background: var(--theme-button-bg, rgba(30, 41, 59, 0.82));
  color: var(--theme-text-primary, #e2e8f0);
  font-size: 12px;
  cursor: pointer;
}

.codex-approval-button.is-accept,
.codex-approval-button.is-acceptForSession {
  background: rgba(37, 99, 235, 0.25);
  border-color: rgba(96, 165, 250, 0.4);
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-approval-button.is-decline,
.codex-approval-button.is-cancel {
  background: rgba(220, 38, 38, 0.15);
  border-color: rgba(248, 113, 113, 0.3);
  color: var(--theme-status-error, #f87171);
}

.codex-loading-thread {
  position: sticky;
  top: 0;
  z-index: 1;
  align-self: flex-start;
  padding: 4px 8px;
  border: 1px solid rgba(96, 165, 250, 0.32);
  border-radius: 999px;
  color: var(--theme-text-primary, #e2e8f0);
  background: rgba(37, 99, 235, 0.24);
  font-size: 11px;
}

.codex-empty {
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}

.codex-output-empty {
  margin: auto;
  max-width: 320px;
  text-align: center;
}

.codex-message {
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.48);
}

.codex-message.is-user {
  border-color: rgba(96, 165, 250, 0.32);
}

.codex-message.is-command {
  border-color: rgba(251, 191, 36, 0.32);
}

.codex-message.is-file-change {
  border-color: rgba(74, 222, 128, 0.32);
}

.codex-message.is-review {
  border-color: rgba(167, 139, 250, 0.32);
}

.codex-message.is-reasoning {
  border-color: rgba(148, 163, 184, 0.24);
  opacity: 0.85;
}

.codex-message-content pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

.codex-command-block {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(2, 6, 23, 0.65);
  margin-bottom: 8px;
}

.codex-command-block code {
  font-family: var(--app-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-file-changes pre {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
}

.codex-review-label,
.codex-reasoning-label {
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.codex-review-label {
  color: var(--theme-accent-primary, #a78bfa);
}

.codex-reasoning-label {
  color: var(--theme-text-muted, #94a3b8);
}

.codex-review-block pre,
.codex-reasoning-block pre {
  margin: 0;
  opacity: 0.9;
}

.codex-message-role {
  margin-bottom: 6px;
  color: var(--theme-text-muted, #94a3b8);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.codex-message pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

.codex-file-preview {
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 12px;
  overflow: hidden;
}

.codex-file-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--theme-text-muted, #94a3b8);
  background: rgba(15, 23, 42, 0.6);
  border-bottom: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
}

.codex-file-preview-body {
  margin: 0;
  padding: 12px;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
  color: var(--theme-text-primary, #e2e8f0);
  background: rgba(2, 6, 23, 0.45);
}

.codex-sandbox {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.35);
}

.codex-sandbox-cwd {
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
  word-break: break-word;
}

.codex-sandbox-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 4px;
}

.codex-sandbox-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.18));
  border-radius: 8px;
  font-size: 12px;
  color: var(--theme-text-primary, #e2e8f0);
  background: var(--theme-button-bg, rgba(30, 41, 59, 0.6));
  cursor: pointer;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-sandbox-item:hover {
  border-color: var(--theme-accent-primary, #60a5fa);
}



.codex-events {
  margin-top: auto;
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}

.codex-events ol {
  margin: 8px 0 0;
  padding-left: 20px;
}

.codex-sandbox-toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
}

.codex-sandbox-input {
  flex: 1 1 auto;
}

.codex-breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
  font-size: 11px;
  margin-bottom: 6px;
}

.codex-breadcrumb-item {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--theme-text-muted, #94a3b8);
  cursor: pointer;
  font-size: 11px;
}

.codex-breadcrumb-item:hover {
  background: rgba(148, 163, 184, 0.12);
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-breadcrumb-item:not(:last-child)::after {
  content: '/';
  margin-left: 4px;
  color: var(--theme-text-muted, #94a3b8);
  opacity: 0.5;
}

.codex-parent-dir {
  border-style: dashed;
  opacity: 0.8;
  width: 100%;
  justify-content: flex-start;
  margin-bottom: 4px;
}

.codex-dir-icon {
  color: var(--theme-accent-primary, #60a5fa);
}

.codex-file-icon {
  color: var(--theme-text-muted, #94a3b8);
}

 .codex-sandbox-item.is-directory {
   font-weight: 600;
 }

 /* Account status styles */
 .codex-account-status {
   display: flex;
   align-items: center;
   gap: 6px;
 }

 .codex-account-badge {
   display: flex;
   align-items: center;
   gap: 6px;
   padding: 4px 10px;
   border-radius: 999px;
   background: rgba(37, 99, 235, 0.18);
   font-size: 12px;
   color: var(--theme-text-primary, #e2e8f0);
 }

 .codex-plan-type {
   padding: 2px 6px;
   border-radius: 4px;
   background: rgba(74, 222, 128, 0.2);
   color: var(--theme-status-success, #4ade80);
   font-size: 10px;
   text-transform: uppercase;
 }

 /* Login panel styles */
 .codex-login-panel {
   display: flex;
   flex-direction: column;
   gap: 12px;
   padding: 12px;
   border-bottom: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
   background: rgba(15, 23, 42, 0.35);
 }

 .codex-login-methods {
   display: grid;
   grid-template-columns: 1fr 1fr;
   gap: 12px;
 }

 .codex-login-section {
   display: flex;
   flex-direction: column;
   gap: 8px;
 }

 .codex-login-label {
   font-size: 11px;
   color: var(--theme-text-muted, #94a3b8);
   text-transform: uppercase;
   letter-spacing: 0.08em;
 }

 .codex-device-code {
   padding: 10px;
   border: 1px dashed var(--theme-accent-primary, rgba(96, 165, 250, 0.5));
   border-radius: 10px;
   text-align: center;
 }

 .codex-device-code p {
   margin: 0 0 8px;
   font-size: 12px;
   color: var(--theme-text-muted, #94a3b8);
 }

 .codex-device-code-url a {
   color: var(--theme-accent-primary, #60a5fa);
   font-size: 12px;
 }

 .codex-device-code-value {
   margin-top: 8px;
   padding: 8px 16px;
   border-radius: 8px;
   background: rgba(2, 6, 23, 0.65);
   font-family: var(--app-monospace-font-family, ui-monospace, monospace);
   font-size: 18px;
   font-weight: 700;
   letter-spacing: 0.1em;
   color: var(--theme-text-primary, #e2e8f0);
 }

 .codex-login-pending {
   font-size: 12px;
   color: var(--theme-text-muted, #94a3b8);
   text-align: center;
 }

 /* Rate limits styles */
 .codex-rate-limits {
   padding: 10px;
   border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
   border-radius: 12px;
   background: rgba(15, 23, 42, 0.35);
   margin: 8px 12px;
 }

 .codex-rate-limit-header {
   display: flex;
   align-items: center;
   justify-content: space-between;
   margin-bottom: 6px;
 }

 .codex-rate-limit-title {
   font-size: 12px;
   color: var(--theme-text-muted, #94a3b8);
   text-transform: uppercase;
   letter-spacing: 0.08em;
 }

 .codex-rate-limit-bar {
   height: 6px;
   border-radius: 3px;
   background: rgba(148, 163, 184, 0.2);
   overflow: hidden;
 }

 .codex-rate-limit-fill {
   height: 100%;
   border-radius: 3px;
   background: var(--theme-status-success, #4ade80);
   transition: width 0.3s ease;
 }

 .codex-rate-limit-fill.is-high {
   background: var(--theme-status-warning, #fbbf24);
 }

  .codex-rate-limit-info {
    margin-top: 6px;
    font-size: 11px;
    color: var(--theme-text-muted, #94a3b8);
  }

  .codex-fs-suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 100;
    margin: 2px 0 0;
    padding: 4px 0;
    list-style: none;
    background: var(--theme-panel-bg, rgba(30, 41, 59, 0.95));
    border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.18));
    border-radius: 8px;
    max-height: 200px;
    overflow-y: auto;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .codex-fs-suggestions li {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--theme-text-primary, #e2e8f0);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .codex-fs-suggestions li:hover,
  .codex-fs-suggestions li.is-selected {
    background: var(--theme-button-hover-bg, rgba(96, 165, 250, 0.15));
  }

  .codex-thread-cwd {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--theme-accent-primary, #60a5fa);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .codex-sandbox-toolbar {
    position: relative;
  }

  .codex-sandbox-toolbar .codex-input {
    position: relative;
    z-index: 10;
  }
</style>
