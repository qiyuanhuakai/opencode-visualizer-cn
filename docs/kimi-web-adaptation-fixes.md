# Kimi Web 漏适配修复索引

整理日期：2026-09-29。

本文件记录此前已经修复的 Kimi Web 漏适配问题，供后续升级 Kimi Code、排查回归或接入其他后端时参考。它不是未完成事项列表。记录覆盖初始适配、Kimi Code 2.0.2 界面补齐及后续兼容修复；`docs/kimi.md` 的 0.43.0 调研和 `docs/kimi-2.0.2.md` 是当时的协议与验收快照，部分旧入口描述不代表当前界面。当前行为应以代码、运行时能力探测和实机验证为准。

对应的主要变更为 [PR #138](https://github.com/qiyuanhuakai/opencode-visualizer-cn/pull/138)、[PR #139](https://github.com/qiyuanhuakai/opencode-visualizer-cn/pull/139)、[PR #141](https://github.com/qiyuanhuakai/opencode-visualizer-cn/pull/141)、[PR #144](https://github.com/qiyuanhuakai/opencode-visualizer-cn/pull/144) 和 [PR #147](https://github.com/qiyuanhuakai/opencode-visualizer-cn/pull/147)。发布记录见 [`CHANGELOG.md`](../CHANGELOG.md)。

## 协议、能力与后端切换

| 曾出现的漏适配表现 | 修复后的契约与排查入口 |
| --- | --- |
| 浏览器直接连接 Kimi Web 被 Origin 白名单拒绝，或把 HTTP 200 当成业务成功。 | REST/WS 经 `vis_bridge` 代理；REST 必须检查 `{code,msg,data,request_id}`，`code != 0` 属于业务失败。Kimi bearer 由 bridge 读取并注入，前端只使用 bridge 凭据。见 [`kimiWeb.ts`](../app/utils/kimiWeb.ts)、[`kimiWebAdapter.ts`](../app/backends/kimiWeb/kimiWebAdapter.ts)。 |
| 状态监控把 MCP、Skill、Plugin 恒显为不支持，把 bridge 版本误当 Kimi 版本；无会话标识的探测响应被误判。 | 以当前连接的 `/api/v1/meta`、`/api/v1/auth` 和安全动作探测为准；失败显示未知并关闭相关入口，版本取 `meta.server_version`。切换连接时清除旧探测结果。见 [`capabilityRegistry.ts`](../app/backends/kimiWeb/capabilityRegistry.ts)、[`StatusMonitorModal.vue`](../app/components/StatusMonitorModal.vue)。 |
| 切换 OpenCode、Codex、ACP、Kimi Web 后，上一个后端的模型、agent 或 composer 设置残留。 | 激活后端时清理跨后端的临时选择状态，保留合法的持久化偏好；过期异步响应不得覆盖新连接。见 [`App.vue`](../app/App.vue)。 |
| Kimi 原生 PTY 不可用时，文件树或 Shell 被错误地判为完全不可用。 | 文件树走会话级文件 API；Shell 走 Vis bridge 的 PTY 接口，两者分别判定能力。见 [`kimiWebAdapter.ts`](../app/backends/kimiWeb/kimiWebAdapter.ts)、[`useFileTree.ts`](../app/composables/useFileTree.ts)。 |

## 会话、项目与实时消息

| 曾出现的漏适配表现 | 修复后的契约与排查入口 |
| --- | --- |
| 顶部树把 Git 与非 Git 项目混在一起；分支名变化造成会话换组、重复或丢失；子代理任务被误当独立会话。 | 保持 workspace → directory/branch → session 的稳定归属；同一 Git 仓库的分支和 worktree 归同一沙盒，非 Git 目录按全局规则组织。独立 child session 才按 `parent_session_id` 归属父会话，同会话 agent/task 不进入会话树。见 [`useBackendSessionTrees.ts`](../app/composables/useBackendSessionTrees.ts)、[`kimiWebSessionTrees.ts`](../app/composables/kimiWebSessionTrees.ts)。 |
| 新建会话后未切换、选中了归档或 child 会话，或者较慢的旧响应覆盖当前选中项。 | 先写会话 profile/model、登记树，再发布选择；初始化跳过不适合作默认入口的会话，并用请求世代隔离过期响应。见 [`useBackendSessionLifecycle.ts`](../app/composables/useBackendSessionLifecycle.ts)。 |
| 会话状态未曾活动却显示绿色 Idle；运行结束仍显示 Busy；底部状态与会话树不一致。 | 本次连接尚未运行的会话为灰色空心 Unknown，发送后 Busy，轮次结束后 Idle；按活跃子代理状态更新思考标识。见 [`kimiWebSessionEvents.ts`](../app/composables/kimiWebSessionEvents.ts)、[`StatusBar.vue`](../app/components/StatusBar.vue)。 |
| 主会话、排队消息和助手回复错配，消息卡片刷新后移动、重复淡入或遗漏文件差异。 | 使用真实 `prompt.submitted` 用户消息 ID 绑定后续输出，按用户根消息维持卡片身份；仅首次回复淡入，完成轮次时刷新该卡片的差异状态。见 [`promptEntries.ts`](../app/backends/kimiWeb/promptEntries.ts)、[`useKimiWebMessageBridge.ts`](../app/composables/useKimiWebMessageBridge.ts)、[`ThreadBlock.vue`](../app/components/ThreadBlock.vue)。 |
| 子代理取消后仍显示运行中；历史子代理、Swarm 结果的思考或工具内容缺失。 | 处理 `subagent.cancelled` 终态，历史卡片和关联悬浮窗保留子代理思考、工具及结果。见 [`normalize.ts`](../app/backends/kimiWeb/normalize.ts)、[`handlers-events.ts`](../app/backends/kimiWeb/handlers-events.ts)、[`historyEntries.ts`](../app/backends/kimiWeb/historyEntries.ts)。 |

## 模型、权限与提供商

| 曾出现的漏适配表现 | 修复后的契约与排查入口 |
| --- | --- |
| 输入栏 agent/模型列表或提供商管理为空，Ready 被目录加载阻塞。 | 绑定适配器方法，Ready 后并行加载提供商和模型；兼容 2.0.2 catalog、`display_name`、输入模态和思考强度目录。UI 组合 ID 与发送给 Kimi 的原始模型别名分离，发送前等待配置完成。见 [`kimiWebAdapter.ts`](../app/backends/kimiWeb/kimiWebAdapter.ts)、[`modelSelection.ts`](../app/backends/kimiWeb/modelSelection.ts)、[`useKimiWebProviders.ts`](../app/composables/useKimiWebProviders.ts)。 |
| `manual`、`auto`、`yolo` 被误译、误显示为 `main`，或权限随当前下拉选项改变旧卡片。 | 三种权限保留协议原名与颜色；按发送时的选项执行、保存每轮权限并记住选择，历史缺少本地记录时按服务端默认权限回退。`plan` 是独立布尔模式，不是 `permission_mode` 的第四个值。见 [`sessionModes.ts`](../app/backends/kimiWeb/sessionModes.ts)、[`turnPermissions.ts`](../app/backends/kimiWeb/turnPermissions.ts)、[`ThreadBlock.vue`](../app/components/ThreadBlock.vue)。 |
| plan/swarm/tower 占满底栏，tower 实验开关与会话模式混同，模式写入失败误报成功。 | 三种模式收入向上展开的「模式」菜单，协议名称保持小写；tower 的实验开关单独放在紧凑设置菜单，模式入口仍受实时实验标志约束。业务拒绝只回滚对应字段，过期响应不能覆盖较新的状态。见 [`KimiWebComposerModes.vue`](../app/components/kimiWeb/KimiWebComposerModes.vue)、[`KimiWebAgentManager.vue`](../app/components/kimiWeb/KimiWebAgentManager.vue)、[`useKimiWebSessionModes.ts`](../app/composables/useKimiWebSessionModes.ts)。 |
| 子智能体默认模型和思考强度无法设置；子会话查看占空间且下拉框不符合主题。 | 设置图标打开紧凑主题化菜单，读取并保存 `secondary_model` 默认模型/力度；移除无用的子会话浏览器，选择器使用 Vis Dropdown。见 [`KimiWebAgentManager.vue`](../app/components/kimiWeb/KimiWebAgentManager.vue)、[`KimiWebComposerActions.vue`](../app/components/kimiWeb/KimiWebComposerActions.vue)。 |
| 提供商卡片过大、点击「连接」后表单堆在页底、目录刷新/导入无效。 | 已安装与目录使用紧凑列表；连接进入二级界面；提供商搜索、A–Z 排序、首字母导航，自定义提供商入口位于搜索框上方。移除无效的 Kimi 目录导入和刷新按钮。见 [`KimiWebProviderManager.vue`](../app/components/kimiWeb/KimiWebProviderManager.vue)、[`ProviderDiscoveryList.vue`](../app/components/ProviderDiscoveryList.vue)。 |
| 创建/更新提供商混用造成冲突，编辑时意外清除 API key，含 `/` 的模型 ID 设置默认值失败。 | 创建用 `POST /providers`、更新用 `PUT /providers/{id}`；API key 明确保留/替换/移除三态，冲突提示改用更新；模型 ID 做 URL 编码。配置读取失败不清空已取到的提供商列表。见 [`kimiWebProviderMapping.ts`](../app/backends/kimiWeb/kimiWebProviderMapping.ts)、[`KimiWebProviderManager.vue`](../app/components/kimiWeb/KimiWebProviderManager.vue)。 |

## 历史、卡片与文件操作

| 曾出现的漏适配表现 | 修复后的契约与排查入口 |
| --- | --- |
| 历史只显示文本，漏掉工具调用、Shell、网络搜索、思考或工具结果；完整思考被重复输出。 | 倒序分页拼成正序，过滤 `metadata.origin.kind === 'injection'`；折叠工具结果到调用，并合并相邻思考片段、移除服务端重复的完整片段。见 [`history.ts`](../app/backends/kimiWeb/history.ts)、[`historyEntries.ts`](../app/backends/kimiWeb/historyEntries.ts)。 |
| 模型名称重复提供商名，状态监控报告错误的模型/上下文，或误说 Kimi 不提供 Token。 | 消息卡片使用精简的模型展示名；Token 页以会话状态、实时累计用量或会话快照显示模型、上下文与用量，账户额度按 Kimi 返回的窗口显示。见 [`modelSelection.ts`](../app/backends/kimiWeb/modelSelection.ts)、[`tokenUsage.ts`](../app/backends/kimiWeb/tokenUsage.ts)、[`KimiAccountUsage.vue`](../app/components/kimiWeb/KimiAccountUsage.vue)。 |
| 文件树不列隐藏/ignored 文件，ignored 项未灰显，点击文件为空白。 | 会话级 `fs:list`/读取接口处理相对路径和 `kind` 字段；保留隐藏与 Git 忽略项，忽略项用灰色文字。见 [`kimiWebAdapter.ts`](../app/backends/kimiWeb/kimiWebAdapter.ts)、[`useFileTree.ts`](../app/composables/useFileTree.ts)。 |
| 消息卡片的分支、差异、撤销报错；无差异仍显示差异按钮。 | 分支先复制会话再在副本撤销到所选检查点；撤销仅改变会话上下文，不恢复工作区文件；差异读取轮次文件快照，只有存在变更才展示入口，并拒绝跨压缩检查点撤销。相关操作受当前连接的能力探测门控。见 [`kimiWebCardActions.ts`](../app/utils/kimiWebCardActions.ts)、[`capabilityRegistry.ts`](../app/backends/kimiWeb/capabilityRegistry.ts)。 |
| 项目选择器无法进入 `/` 或 `~/` 的目录，或在 Git worktree 的 `.git` 文件下错误继续下钻。 | 根目录和主目录允许浏览；普通仓库的 `.git` 目录与 worktree 的 `.git` 文件都被识别为项目边界。见 [`ProjectPicker.vue`](../app/components/ProjectPicker.vue)。 |

## 命令、旁支窗口与视觉

| 曾出现的漏适配表现 | 修复后的契约与排查入口 |
| --- | --- |
| 压缩、复制仍在「更多」菜单，复制只得到局部文本或不能复制完整历史。 | 压缩交给 `/compact`；`/copyall` 分页读取全部会话消息后生成 Markdown，历史不完整时不写剪贴板。新增 `/new`、`/clear`、`/fork`、`/undo`、`/status`、`/subagent` 等本地路由。见 [`slashCommands.ts`](../app/backends/kimiWeb/slashCommands.ts)、[`copyAll.ts`](../app/backends/kimiWeb/copyAll.ts)、[`App.vue`](../app/App.vue)。 |
| `/btw` 复用上次窗口、暴露主会话历史、偶尔不弹窗，追问完成后一直显示「思考中」。 | 每次命令调用都创建新的 side agent 与浮窗；先记录继承历史的 ordinal 基线，窗口只显示基线之后的旁支轮次；窗口内可继续追问，完成状态不保留旧「思考中」。见 [`KimiWebBtwWindow.vue`](../app/components/kimiWeb/KimiWebBtwWindow.vue)、[`App.vue`](../app/App.vue)。 |
| 提示停在内容区、服务器行被裁切、插件/额度/设置弹窗和原生下拉框不符合 Vis 视觉。 | 反馈使用统一状态提示；相关面板复用 Vis 的紧凑尺寸、主题色、浮窗和 Dropdown。新增页面要同时适配当前 Vis 主题，不使用系统原生下拉框；通用规则见 [`DESIGN.md`](../DESIGN.md)。 |

## 再次适配时的验证顺序

1. 先记录 `kimi --version`、实时 `/api/v1/meta`、`/api/v1/auth` 与具体动作探测结果；不要把 0.43.0 fixture、路由存在或 HTTP 200 当成当前服务端能力。
2. 覆盖空会话、新建与切换、Git 仓库及 worktree、非 Git 目录、排队轮次、历史分页、权限切换、文件树和 Shell；检查旧异步响应不会污染新会话。
3. 在真实浏览器检查提供商二级界面、状态监控、卡片差异/撤销、两次连续 `/btw` 的独立空白窗口与追问，以及明暗主题和窄屏布局。
4. 对照 [`docs/kimi.md`](kimi.md)、[`docs/kimi-2.0.2.md`](kimi-2.0.2.md) 的协议证据，并运行对应的 Kimi Web 测试、类型检查和构建；历史快照与当前实现冲突时，以当次实时协议和测试为准。
