本文档系统梳理了 vis.thirdend 前端应用的客户端持久化体系，涵盖存储键的命名规范、双后端存储适配（Web localStorage 与 Electron 持久化文件）、数据迁移策略，以及跨窗口状态同步机制。理解这些机制有助于在扩展新功能时保持存储行为的一致性与可靠性。

## 存储键命名规范

所有存储键统一通过 `StorageKeys` 常量对象集中管理，避免在业务代码中硬编码字符串。键名遵循三段式结构：`{domain}.{name}.v{version}`，并统一附加 `opencode.` 前缀。`domain` 用于区分数据语义类别，当前定义了 `settings`（用户偏好设置）、`state`（运行时状态）、`drafts`（草稿数据）、`favorites`（收藏数据）与 `auth`（认证信息）五大域。

| 域 | 键名示例 | 数据类型 | 用途 |
|---|---|---|---|
| `settings` | `settings.enterToSend.v1` | 字符串/布尔 | 发送消息快捷键行为 |
| `settings` | `settings.themeTokens.v2` | JSON | 主题令牌覆盖（含版本升级） |
| `settings` | `settings.themeRegistry.v1` | JSON | 外部自定义主题注册表 |
| `settings` | `settings.locale.v1` | 字符串 | 界面语言（独立常量） |
| `state` | `state.sidePanelCollapsed.v1` | 字符串 | 侧边栏折叠状态 |
| `state` | `state.pinnedSessions.v1` | JSON | 本地会话置顶覆盖 |
| `state` | `state.sessionTreeExpanded.v1` | JSON | 会话树展开路径 |
| `state` | `state.deletedSandboxes.v1` | JSON | 已删除沙盒标记 |
| `state` | `state.lastAuthError.v1` | 字符串 | 最近一次认证错误信息 |
| `drafts` | `drafts.composer.v1` | JSON | 多上下文编辑器草稿 |
| `drafts` | `drafts.question.v1` | JSON | 问题弹窗草稿 |
| `favorites` | `favorites.messages.v1` | JSON | 收藏消息列表 |
| `auth` | `auth.backendKind.v1` | 字符串 | 当前后端类型 |
| `auth` | `auth.credentials.v1` | JSON | OpenCode 认证凭据 |
| `auth` | `auth.serverUrl.v1` | 字符串 | OpenCode 服务器地址 |
| `auth` | `auth.codexBridgeUrl.v1` | 字符串 | Codex 桥接地址 |
| `auth` | `auth.codexBridgeToken.v1` | 字符串 | Codex 桥接令牌 |

版本号后缀（如 `.v1`、`.v2`）是命名规范的核心设计：当存储数据结构发生不兼容变更时，通过提升版本号创建新键，旧键保留供迁移逻辑读取，从而避免数据损坏。例如主题系统从基于 `regionTheme` 的 V1 配置迁移到基于 `themeTokens` 的 V2 语义令牌体系时，`settings.regionTheme.v1` 被读取后转换写入 `settings.themeTokens.v2`，随后删除旧键。

Sources: [storageKeys.ts](app/utils/storageKeys.ts#L47-L89)

## 双后端存储适配层

应用通过 `resolveStorageBackend()` 实现了一套透明的存储后端选择逻辑：在 Electron 桌面环境中优先使用主进程提供的 `persistentStorage`（基于文件系统的 JSON 持久化），在纯 Web 环境中回退到 `window.localStorage`。这一抽象对上层业务完全透明，所有读写均通过 `storageGet`、`storageSet`、`storageRemove` 以及 JSON 封装版本 `storageGetJSON` / `storageSetJSON` 完成。

Electron 持久化存储的实现位于主进程，数据保存在用户数据目录下的 `renderer-storage.json` 文件中。主进程通过 `ipcMain` 暴露同步 IPC 通道（`persistent-storage-get`、`persistent-storage-set`、`persistent-storage-remove`），并在数据变更时通过 `persistent-storage-changed` 事件广播给所有非来源窗口，以模拟浏览器原生的 `storage` 事件行为。预加载脚本（preload）负责将主进程 API 安全地注入到渲染进程的 `window.electronAPI` 命名空间下。

Sources: [storageKeys.ts](app/utils/storageKeys.ts#L35-L45), [main.js](electron/main.js#L261-L293), [preload.cjs](electron/preload.cjs#L45-L49)

## 数据迁移策略

项目通过三种互补机制处理存储格式的演进：版本号隔离、运行时迁移函数，以及一次性迁移标记。

**版本号隔离** 是最主要的策略。`StorageKeys` 中每个键都携带版本后缀，当数据结构变更时引入新键，旧键在迁移逻辑中被读取并转换后删除。`useSettings` 中的主题迁移是典型示例：启动时先尝试读取 `settings.themeTokens.v2`，若不存在则读取 `settings.regionTheme.v1`，通过 `migrateLegacyRegionThemeStorage` 转换为 V2 格式后写入新键并清理旧键。

**运行时迁移函数** 用于处理未纳入 `StorageKeys` 的遗留键。`useCredentials` 中的 `migrateLegacyCredentials()` 读取旧键 `credentials.v1`，将其内容拆分写入 `auth.serverUrl.v1` 与 `auth.credentials.v1`，随后删除旧键。这种迁移在首次加载时惰性执行，无需用户干预。

**一次性迁移标记** 用于 Electron 环境下的 localStorage 到文件存储的整体迁移。`migrateLocalStorageToElectronStorage` 在检测到 Electron 持久化后端可用时，遍历所有以 `opencode.` 为前缀的 localStorage 条目，若对应键在 Electron 存储中不存在，则将其复制过去。该过程受 `hasMigratedElectronStorage` 模块级标记保护，确保每个应用生命周期只执行一次。

Sources: [storageKeys.ts](app/utils/storageKeys.ts#L7-L33), [useSettings.ts](app/composables/useSettings.ts#L125-L142), [useCredentials.ts](app/composables/useCredentials.ts#L51-L68)

## 跨窗口状态同步

浏览器原生的 `storage` 事件仅在非同源页面或同一浏览器的不同标签页间触发，单页应用内部的状态变更不会自动传播。为解决多窗口场景（尤其是 Electron 多窗口）下的状态同步问题，项目建立了统一的跨窗口监听模式：每个管理持久化状态的模块在初始化时注册 `window.addEventListener('storage', ...)` 监听器，当检测到本模块关注的键发生变更时，将新值同步到内存中的响应式引用。

Electron 主进程在持久化数据变更时主动广播 `persistent-storage-changed` 事件，预加载脚本将其转换为标准的 `StorageEvent` 派发到窗口，从而使前端代码无需区分 Web 与 Electron 环境即可实现跨窗口同步。`useSettings`、`useCredentials`、`useFavoriteMessages` 以及 `App.vue` 中的草稿、置顶会话等模块均遵循这一模式。

Sources: [useSettings.ts](app/composables/useSettings.ts#L260-L322), [useCredentials.ts](app/composables/useCredentials.ts#L181-L216), [preload.cjs](electron/preload.cjs#L3-L14)

## 写入优化与防抖策略

不同数据类型采用差异化的持久化频率策略，以平衡数据安全与性能开销。

**同步即时写入** 适用于高频交互但数据量极小的布尔/数值设置项。`useSettings` 中所有基础设置（如 `enterToSend`、`dockAlwaysOpen`、字体大小等）均通过 Vue 的 `watch` 配合 `flush: 'sync'` 选项，在值变更的瞬间同步写入存储。这确保了用户偏好不会因页面刷新而丢失，且单次写入开销极低。

**防抖写入** 适用于批量变更或计算成本较高的场景。主题系统的 `useRegionTheme` 在语义令牌调整时，通过 140ms 的 `setTimeout` 防抖聚合连续变更，并在 `beforeunload` 与 `pagehide` 事件中强制刷盘，避免高频 CSS 变量调整触发大量磁盘写入。

**微任务批处理** 适用于可能连续多次变更的复合数据结构。`App.vue` 中的置顶会话本地覆盖（`pinnedSessions`）通过 `queueMicrotask` 将多次内存更新合并为一次存储写入，减少 JSON 序列化与磁盘 I/O 的重复开销。

Sources: [useSettings.ts](app/composables/useSettings.ts#L172-L177), [useRegionTheme.ts](app/composables/useRegionTheme.ts#L21-L73), [App.vue](app/App.vue#L2795-L2809)

## 数据校验与容错

所有从存储读取的数据均经过防御性解析与规范化处理，避免损坏数据导致应用崩溃。`storageGetJSON` 在 `JSON.parse` 失败时静默返回 `null`；各业务模块在此基础上进一步执行结构校验。例如 `deletedSandboxes.ts` 在读取后验证每项是否为字符串数组并去重归一化路径；`pinnedSessions.ts` 过滤掉非有限数值与零值条目，并按置顶时间排序截断；`useFavoriteMessages` 通过 `toFavoriteMessageEntry` 守卫函数确保每个收藏项至少包含有效的 `text` 字段。

这种“读取即校验、写入即归一化”的哲学贯穿整个持久化层，使得即使存储被外部工具篡改或旧版本残留数据存在，应用也能以安全默认值启动。

Sources: [storageKeys.ts](app/utils/storageKeys.ts#L125-L137), [deletedSandboxes.ts](app/utils/deletedSandboxes.ts#L24-L39), [pinnedSessions.ts](app/utils/pinnedSessions.ts#L16-L34), [useFavoriteMessages.ts](app/composables/useFavoriteMessages.ts#L13-L39)

## 扩展指南：添加新的持久化字段

当需要为新增功能引入客户端持久化时，建议遵循以下步骤：

1. **在 `StorageKeys` 中注册键名**：选择语义恰当的域（`settings`、`state`、`drafts`、`favorites`、`auth`），采用 `{domain}.{name}.v1` 格式命名，并考虑未来是否需要版本升级。
2. **选择存储 API**：字符串/数值优先使用 `storageGet` / `storageSet`；对象/数组优先使用 `storageGetJSON` / `storageSetJSON`。
3. **实现读写封装**：在对应的 composable 或工具模块中封装 `readXxx()` 与 `writeXxx()` 函数，内置默认值与校验逻辑。
4. **接入响应式同步**：若该状态需要在 UI 中响应，使用 Vue `watch` 监听内存引用并在变更时写入存储；同时注册 `storage` 事件监听器以支持跨窗口同步。
5. **考虑迁移路径**：若替换已有键，保留旧键读取逻辑并在首次加载时执行迁移，随后删除旧键。

Sources: [storageKeys.ts](app/utils/storageKeys.ts#L91-L137)

## 相关阅读

- [全局状态与事件系统](6-quan-ju-zhuang-tai-yu-shi-jian-xi-tong) — 了解应用级响应式状态的设计原则
- [主题令牌与区域配色系统](21-zhu-ti-ling-pai-yu-qu-yu-pei-se-xi-tong) — 深入主题存储的 V1 到 V2 迁移细节
- [国际化与多语言支持](20-guo-ji-hua-yu-duo-yu-yan-zhi-chi) — 语言设置的持久化与动态切换
- [提供商与模型管理](25-ti-gong-shang-yu-mo-xing-guan-li) — 认证凭据与后端配置的存储关联