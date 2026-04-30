本文档聚焦 Vis 应用中会话管理的三大核心能力：会话选择（Session Selection）、置顶体系（Pinning Hierarchy）与批量操作（Batch Operations）。这些功能横跨 `TopPanel` 顶部面板、`SidePanel` 侧边栏会话树以及底层状态管理，构成了用户在多项目、多沙盒、多会话场景下的主要导航与组织手段。

## 会话选择：从自动恢复到精确切换

### 选择状态模型

应用通过 `useSessionSelection` 组合式函数维护两个核心响应式状态：`selectedProjectId` 与 `selectedSessionId`。该组合式函数接收来自 `useServerState` 的全局项目状态 `projects`、会话创建回调 `createSessionFn` 以及国际化翻译函数 `translate`，封装了所有与会话定位相关的逻辑。

`ensureSession` 方法是选择状态的核心保障机制。当用户尚未选择任何项目或会话时，它会按以下优先级自动恢复：
1. 优先查找全局范围内**最近置顶**（`timePinned` 最大）的根会话；
2. 若置顶时间相同，则比较 `timeUpdated` 或 `timeCreated`，取最新者；
3. 若仍无匹配，则回退到第一个可用项目的首个会话；
4. 极端情况下若项目无任何会话，则通过 `createSessionFn` 自动创建新会话并选中。

`switchSession` 方法则提供了**精确切换**能力。它接收目标 `projectId` 与 `sessionId`，通过 `waitForState` 工具等待服务端状态同步确认目标会话真实存在后，再更新选择状态。这种"等待确认再切换"的模式避免了在 SSE 状态尚未同步时产生无效选择。

Sources: [useSessionSelection.ts](app/composables/useSessionSelection.ts#L47-L152)

### 自动回退与验证

当当前选中的会话被归档、删除或变为子会话时，`validateSelectedSession` 函数会触发自动回退。它调用 `pickPreferredSessionId` 从同项目剩余候选中按置顶优先、时间次之的规则选出接替者。`compareSessionsForSelection` 比较器是这一排序策略的核心实现：先比较有效置顶时间戳（`getSessionEffectivePinnedAt`），再比较更新时间。

Sources: [App.vue](app/App.vue#L2425-L2460)

## 置顶体系：三级层级与乐观本地覆盖

### 三级置顶层级

Vis 的置顶系统支持**项目（Project）→ 沙盒（Sandbox）→ 会话（Session）** 三级层级，形成自上而下的继承关系。侧边栏 `SessionTree` 仅展示被置顶树覆盖的会话，因此置顶同时起到了"组织视图"的作用。

| 层级 | 存储键格式 | 继承行为 |
|------|-----------|---------|
| 项目 | `project:{projectId}` | 其下所有沙盒与会话默认可见 |
| 沙盒 | `sandbox:{projectId}:{directory}` | 其下所有会话默认可见，可被项目级覆盖 |
| 会话 | `{projectId}:{sessionId}` | 最细粒度，直接控制单个会话的显隐 |

`isSessionEffectivelyPinned` 函数实现了这一继承逻辑：若项目或沙盒被置顶，则其下会话隐式置顶；若会话本身有独立的本地覆盖值，则以该值为准。

Sources: [pinnedSessions.ts](app/utils/pinnedSessions.ts#L47-L95)

### 乐观本地覆盖与服务器协调

由于置顶状态通过 REST API 修改，网络延迟会影响交互体验。系统引入了**乐观本地覆盖（Optimistic Local Override）** 机制：用户点击置顶/取消置顶时，立即写入 `localPinnedSessionStore`，UI 即时响应，同时后台异步调用 `openCodeApi.pinSession` 或 `openCodeApi.unpinSession`。

`localPinnedSessionStore` 的值具有语义：
- **正值**（如 `Date.now()`）：本地乐观置顶，待服务器确认；
- **负值**（如 `-Date.now()`）：本地乐观取消置顶，用于覆盖父级继承；
- **不存在**：以服务器状态为准。

`reconcilePinnedSessionStore` 函数负责**协调（Reconciliation）**。它定期比对本地覆盖与服务器实际状态：当服务器状态已追上本地乐观值（如服务器 `timePinned` 等于本地正值），则删除该覆盖；当会话已被归档或删除，则清理其相关覆盖。协调由 `watch` 在 `selectedProjectId`、`selectedSessionId`、`activeDirectory` 变化以及服务器会话属性变化时触发。

Sources: [pinnedSessions.ts](app/utils/pinnedSessions.ts#L97-L159), [App.vue](app/App.vue#L3021-L3035)

### 级联取消与清理

取消置顶操作涉及复杂的级联逻辑。以 `unpinSession` 为例：若会话是被**直接置顶**的，则调用服务器 API 取消置顶；若会话是**隐式置顶**（通过父项目或沙盒继承），则写入负值覆盖。当某个沙盒下所有会话都被取消置顶后，系统会自动向上级联取消沙盒置顶；若项目下所有沙盒均不可见，则进一步取消项目置顶。`pinProject`、`unpinProject`、`pinSandbox`、`unpinSandbox` 四个函数共同维护了这一级联一致性。

Sources: [App.vue](app/App.vue#L4161-L4290)

## 批量操作：管理模式与并发控制

### 管理模式（Management Mode）

`TopPanel` 的会话下拉树提供了一个**管理模式**入口。用户点击管理按钮后，`managementMode` 状态激活，下拉树中的每个会话项前出现复选框，用户可多选会话进行批量操作。

`managedSessionKeys` 数组以 `${projectId}::${directory}::${sessionId}` 格式记录当前选中的会话键。`sessionTargetMapByKey` 计算属性将 `treeData` 中的会话映射为可快速查找的结构。`selectedEntries` 则根据选中键反查对应的会话元数据与批量操作目标对象。

Sources: [TopPanel.vue](app/components/TopPanel.vue#L840-L900)

### 批量操作目标计算

系统根据选中会话的当前状态，**动态计算**每种批量操作的有效目标集：

| 操作 | 有效条件 | 计算属性 |
|------|---------|---------|
| 置顶 | 未归档且未被置顶（直接或间接） | `batchPinTargets` |
| 取消置顶 | 未归档且已被置顶 | `batchUnpinTargets` |
| 归档 | 未归档 | `batchArchiveTargets` |
| 取消归档 | 已归档 | `batchUnarchiveTargets` |
| 删除 | 无限制 | `batchDeleteTargets` |

`batchSessionTargetsByAction` 将上述计算属性聚合为按操作类型索引的对象，供管理工具栏渲染各操作的可用数量。

Sources: [TopPanel.vue](app/components/TopPanel.vue#L905-L950)

### 并发执行与错误处理

当用户触发批量操作时，`TopPanel` 通过 `emit('batch-session-action')` 将操作类型与会话目标数组传递给 `App.vue` 的 `handleTopPanelBatchSessionAction` 处理函数。

该函数首先通过 `isBatchSessionAction` 校验操作类型合法性，再使用 `normalizeBatchSessionTargets` 对目标进行规范化：过滤无效项、去除空白、按 `projectId+directory+sessionId` 去重。随后，通过 `mapWithConcurrency` 以 **6 并发度** 异步执行每个目标的操作。

`mapWithConcurrency` 实现了有限并发控制：启动最多 `concurrency` 个工作协程，每个协程从共享索引队列中获取下一个任务并执行，结果以 `PromiseSettledResult` 数组返回。`App.vue` 收集所有 `rejected` 结果，将首个错误信息展示在状态栏中，同时保留成功的操作结果。

对于 OpenCode 后端，批量操作通过 `updateSession` REST API 修改 `time.pinned` 或 `time.archived` 字段；对于 Codex 后端，则调用 `codexApi.pinThread`、`archiveThread` 等桥接方法，直接操作本地存储的线程 ID 集合。

Sources: [batchSessionTargets.ts](app/utils/batchSessionTargets.ts#L1-L52), [mapWithConcurrency.ts](app/utils/mapWithConcurrency.ts#L1-L36), [App.vue](app/App.vue#L4492-L4560)

## 会话树渲染：两级缓存与数据转换

### 数据转换流水线

原始服务器状态 `serverState.projects` 是 `Record<string, ProjectState>` 的嵌套结构，不适合直接渲染。`App.vue` 中定义了两条转换流水线：

1. **`topPanelTreeData`**：供 `TopPanel` 使用，包含搜索过滤、归档会话处理、每沙盒最多 5 个会话的截断逻辑，以及项目颜色等展示属性。
2. **`sessionTreeData`**：供 `SidePanel` 的 `SessionTree` 使用，仅包含被置顶树覆盖的会话，结构严格对应 `SessionTreeProject[] → SessionTreeSandbox[] → SessionTreeSession[]`。

两条流水线共享同一套 `computeProjectsHash` 哈希函数，该函数混合了项目结构、会话时间戳、置顶状态以及本地覆盖存储的哈希值，用于判断缓存是否失效。

Sources: [App.vue](app/App.vue#L1592-L1780), [session-tree.ts](app/types/session-tree.ts#L1-L35)

### 缓存策略

为避免频繁重算，`App.vue` 使用 `shallowRef` 维护两个缓存对象：`treeDataCache` 与 `sessionTreeDataCache`。每个缓存对象包含 `data`、`hash` 与 `timestamp` 三个字段。当当前哈希与缓存哈希一致且时间戳在 15 秒（`TREE_DATA_CACHE_TTL_MS`）内时，直接返回缓存数据。这种**时间窗口+内容哈希**的双重校验，在状态高频更新（如 SSE 推送）时显著降低了 Vue 的响应式重计算开销。

Sources: [App.vue](app/App.vue#L1580-L1591), [App.vue](app/App.vue#L1667-L1680)

## 组件交互：事件流与职责边界

### 事件冒泡路径

会话相关操作的事件流遵循"叶子组件发射 → 中间层透传 → 根组件处理"的模式：

```
SessionTree.vue / TopPanel.vue
    ↓ 发射 pin-session / select-session / batch-session-action 等事件
SidePanel.vue（仅透传，无业务逻辑）
    ↓ 透传至 App.vue
App.vue
    ↓ 调用 useSessionSelection / openCodeApi / 本地状态操作
```

`SidePanel.vue` 在此路径中仅作为**事件透传层**，不持有任何会话管理状态。这种设计确保了所有业务逻辑集中在 `App.vue` 与组合式函数中，便于统一处理错误、乐观更新与后端适配。

Sources: [SidePanel.vue](app/components/SidePanel.vue#L138-L143), [SessionTree.vue](app/components/SessionTree.vue#L157-L162)

### 持久化与存储

本地置顶覆盖存储在 `localStorage`（或 Electron 持久化存储）中，键名为 `opencode.state.pinnedSessions.v1`。`readPinnedSessionStore` 与 `writePinnedSessionStore` 负责读写，并自动应用 `limitPinnedSessionStore` 限制条目上限为 10000。写入操作通过 `queueMicrotask` 批量合并，避免高频更新导致的存储抖动。

会话树的展开状态则存储在 `opencode.state.sessionTreeExpanded.v1` 中，以字符串数组形式记录当前展开的路径标识（如 `project:p1`、`sandbox:p1:/repo`）。

Sources: [App.vue](app/App.vue#L2760-L2795), [storageKeys.ts](app/utils/storageKeys.ts#L35-L42)

## 相关阅读

- [目录优先的会话树模型](12-mu-lu-you-xian-de-hui-hua-shu-mo-xing) — 了解 `ProjectState`、`SandboxState` 与 `SessionState` 的数据结构设计
- [消息流处理与增量更新](14-xiao-xi-liu-chu-li-yu-zeng-liang-geng-xin) — 深入了解 SSE 状态同步与消息渲染机制
- [全局状态与事件系统](6-quan-ju-zhuang-tai-yu-shi-jian-xi-tong) — 理解 `useServerState` 与 Worker 状态架构
- [OpenCode API 与 REST 接口](23-opencode-api-yu-rest-jie-kou) — 探索后端 API 的完整能力集