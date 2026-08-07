# 变更日志 Changelog

本文档记录本 fork 项目相对于上游 [xenodrive/vis](https://github.com/xenodrive/vis) 的所有功能改进、性能优化和修复。

---

## [Unreleased]

### 会话、子代理与大文件评论修复

- [x] ACP 会话历史从 Pi、Oh My Pi 与 Kimi 的真实本地记录补齐 assistant 完成时间，恢复左下角持续时间，并保留旧 metadata provider 的兼容回退。
- [x] 模型、提供商、Token 与 Status Monitor 请求按后端 identity 和 generation 隔离，切换后端时不再被迟到的 Codex/OpenCode 响应覆盖，同时保留独立 Codex Panel 连接。
- [x] OpenCode 新建子代理在 `session.created` 时立即入树、显示入口并补水标题与历史；失败使用有界退避重试，历史任务引用仍按精确 session ID 恢复。
- [x] OpenCode 会话状态同时处理 status-before-created、稀疏状态快照与 snapshot/SSE 竞态；未报告状态保持 unknown，会话树改由 Vue 精确依赖追踪，`busy ↔ idle` 不再等待切会话或缓存过期。
- [x] 大文件评论在虚拟滚动后按绝对行号和实测行高命中；超大文件即使开启换行也保持单行虚拟化，避免整文件 DOM 卡顿或 OOM，可见行几何与选区计算保持 O(可见行数)。
- [x] 输入框上键历史仅保留根会话中用户可见的文本，排除子代理、synthetic、ignored 与独立或追加式 `<system-reminder>` 内容。
- [x] 会话卡片改为无 spacer 的连续批次加载；子代理优先按 metadata/唯一 description 归属，未归属时暂挂最新卡片并在归属到达后迁移。

### 渲染管线升级：shiki v4 与流式高亮

- [x] shiki 3.22 升级至 4.4.2 并引入 @shikijs/stream；升级前以 17 种语言 × 3 个实际主题完成 51/51 输出字节级一致验证（含 6 个自定义 TextMate grammar 与 markdown-it/diff transformer 链路），业务代码零适配改动。
- [x] "思考中"/"Working" 浮窗的流式 markdown 渲染：围栏感知分块器按 R1–R8 规则识别安全切分点（围栏外空行才切分，列表/表格/缩进 continuation/HTML 块/引用定义防护），稳定块一次渲染入主题+上下文键 LRU 缓存，仅尾部随 delta 重渲染；part 完成或窗口关闭前翻转回默认路径做一次全量渲染收敛，终态与单发渲染逐字节一致。
- [x] 流式期间每次实际 DOM 变更都会触发内容变更通知，修复长输出时滚动条不跟随、直到全部输出完才跳到底部的问题；消息级完成（无 part 级 time.end）同样触发收敛渲染。
- [x] 渲染性能：5.2K 字符 reasoning 文本 848 个 delta 下，worker 解析字节量下降 9.2×、DOM churn 下降 4.1×、每 delta 延迟不随文本增长（基线为 O(n²) 增长）；约 8KB 后墙钟时间反超，41.8K 时快 6.05×。
- [x] 独立 stream worker 协议与 CodeRenderer 可选流式路径：追加式 token 批次、尾行原位重绘、close 收敛为单发渲染等效输出；参数变更重开、挂载前批次缓冲、close/open 竞态与死 worker 悬挂等竞态均已修复并有回归测试。
- [x] render-worker 高亮器状态与高亮缓存按主题隔离，修复主题切换窗口期并发请求跨主题串色与语言状态污染；多行原始 HTML 块（script/pre/style/textarea）在流式切分中保持完整，渲染失败保留已有内容并显示错误而非白屏。
- [x] 新增真实表面 QA 设施：代码流式 21 项与 markdown 流式 41 项 Playwright 场景契约（真 worker + 真 DOM，含故意失败自证），以及流式/全量双路径基准对比 harness。

### Codex Panel 与浮窗修复

- [x] Codex Panel 成功连接后仅持久化自动重连意图；页面刷新时由应用启动生命周期立即重建 transport，并通过真实 `account/read` 恢复账号状态，不再等到重新打开 Panel 才连接。
- [x] OpenCode/ACP 登录、重登录与初始化中止不再断开独立的 Codex Panel transport；Codex 主后端初始化中止或激活失败也只清理当前 transport，保留下一次启动的重连意图，只有用户显式点击 Disconnect 才清除该意图。
- [x] 修复线程加载期间断开连接后 loading 锁无法释放的问题；断开状态下保留线程上下文但禁用线程选择和置顶操作，避免调用已销毁的 adapter。
- [x] 浮动窗口创建时会把陈旧或桌面尺寸与坐标收敛到可见 canvas 内；实时拖动和缩放不再受 canvas、屏幕边缘或输入区限制，`pointerup`、`pointercancel` 或 capture 丢失时统一清理手势，非 owner pointer 与第二指针不能抢占手势；结束后仅独立校准真正越界的坐标轴并保留至少 32px 可拖标题栏，避免阻尼、跨轴回弹和残留 listener 造成随机跳动。
- [x] 修复页面仍在加载、floating extent 暂为 `0×0` 时打开终端等窗口会被压成无高度横条且无法恢复的问题；窗口保留请求尺寸，并在首个有效 extent 到达时执行一次创建布局；异步 `beforeOpen` 采用同 key 最新请求生效语义，关闭窗口不会再被旧请求复活，旧 `beforeClose` 完成后也不会删除后打开的同 key 窗口。
- [x] 浮窗批量关闭会等待全部异步 `beforeClose` 后再同步可见列表，并使尚未完成的旧 open 失效；初始异步内容不再覆盖后续 `setContent`，新建窗口只提供单轴坐标时也会独立生成另一轴的有限位置。

## [v0.7.2 released]

### Codex 后端修复

- [x] 修复 Status Monitor 在 MCP 冷启动超过 3 秒时过早回退到 `config/read`、导致 `codex_apps` 等运行时 MCP 缺失的问题；状态请求现在使用 30 秒有界等待，并继续在超时后回退到已配置状态。

### OpenCode 后端修复

- [x] 修复项目或分支未置顶时遮蔽已置顶下级分支、会话的问题；左侧会话树现在按三级独立置顶状态保留必要的父级容器。
- [x] 修复 linked worktree 的 VCS 分支名尚未补齐时左栏误显示为 `main` 的问题；现在与顶部面板一致回退到实际工作树目录名。
- [x] 修复冷启动后台 hydration 尚未完成时误删非活动项目 session pin 的竞态；仅在目录状态为 `loaded` 后清理 stale pin，并延后 legacy 层级迁移。

## [v0.7.1 released]

### CI 与发布流程

- [x] 为所有 Pull Request 启用完整 CI 矩阵，并以 `Complete CI` 作为 `main` 分支的强制合并门禁；管理员同样不可绕过。
- [x] VIS Release 现在同时构建并发布 Linux `.deb`、macOS `.pkg` 与 Windows NSIS `.exe` 格式的 vis_bridge 安装器，SEA 单文件仅作为安装器载荷，不再作为独立 Release 资产发布。
- [x] 修复 Windows x64/arm64 安装器中的 NSIS 路径转换与插件目录初始化问题，并验证静默安装、重复安装、PATH 去重、命令执行及卸载流程。

### vis_bridge 连接修复

- [x] 修复 Windows Electron Release 与 GitHub Pages 无法连接 `ws://localhost:23004` 的问题；bridge 仅精确信任打包应用的 `app://index.html` 和正式站点的 `https://qiyuanhuakai.github.io` Origin，继续拒绝 `null`、伪造应用来源与外站来源。

## [v0.7.0 released]

### ACP 后端与本地桥接器

- [x] 将 ACP v1 接入为 OpenCode、Codex 之外的第三后端，复用主 OutputPanel、InputPanel、会话与权限交互。
- [x] 在状态监控面板中管理 Pi、Oh My Pi (`omp --mode acp`) 与 Kimi Code 等 ACP Agent。
- [x] 将 vis_bridge 扩展为 OpenCode/Codex/ACP 进程监督器，并提供 Node SEA 单文件构建流程。
- [x] ACP 反向文件与终端调用由 bridge 执行，按 Agent/Session 隔离并限制在会话目录。
- [x] ACP 可选的 list/resume/load 能力按 Agent 声明降级，不伪造协议能力。

### Codex 后端修复

#### Codex app-server 更新相关维护

- [x] 以实际 app-server 探测结果为准建立运行时能力注册表；UI 仅暴露当前连接真实可用的能力，并为明确幂等的读取请求提供受连接 generation 约束的 `-32001` 退避重试。
- [x] 完整接入 command/file approval、结构化 permission request、MCP elicitation、tool user input 与 dynamic tool call 请求；所有响应固定返回收到请求的原连接，切换后端或断开连接时立即清理未决请求与弹窗。
- [x] MCP 表单支持必填字段、accept/decline/cancel 与显式 HTTP/HTTPS 外链；密码和其他 secret answer 仅保存在内存中，不写入草稿或持久化存储。
- [x] 将 `turn/plan/updated` 实时计划投影到左侧 Plan 面板，并按当前线程隔离 pending、in progress 与 completed 状态，不在消息流中重复渲染。
- [x] 新增 Runtime Inspector Panel，集中提供线程 Goal 设置/清除、Account Usage、Provider Capabilities、Permission Profiles、Config Requirements、Loaded Threads 与显式后台终端清理；unsupported、gated 与 unknown 状态均明确展示。
- [x] 接入 External Agent Config、`plugin/read` 插件详情、工作区 `fs/getMetadata` 与 `fs/watch/unwatch`，并保留插件 marketplace 来源身份和组件级 watch 生命周期。

- [x] 按 Codex app-server 当前协议仅显示精确 10,080 分钟的周限额，移除已经失效的 5 小时额度与分钟数文案，并统一 Status Monitor、Codex Panel 与多语言显示。

#### 兼容性与稳定性修复


- [x] 使用 app-server `initialize` 返回的真实运行版本替代硬编码版本，Status Monitor 现在可显示当前 Codex app-server 版本。
- [x] 缩短 Codex 登录关键路径：线程列表就绪后即可进入主界面，模型、工具、配置、自定义提供商与 Codex Panel 数据改为后台加载。
- [x] 修复 Codex reasoning 与非 Web Search 工具调用在主 VIS 中缺失或刷新后消失的问题；适配当前 reasoning 数组与 `collabAgentToolCall` wire 格式，并按线程持久化 app-server 历史接口无法返回的辅助消息。
- [x] 修复仅包含 archived 会话的 fork 默认仍显示的问题；此类 fork 现在默认隐藏，但搜索 `archived` 时仍可检索对应 fork 与 archived 会话。
- [x] 修复 Codex 线程切换、重连、rollback 与后台预加载中的异步竞态，防止旧线程事件、旧账号/配置/模型响应、旧 homedir 与 Git 信息覆盖当前连接或重新写回已回滚历史。
- [x] 修复 Codex 自定义模型提供商线程补水阻塞登录、重复请求基础线程列表及后台合并后线程顺序错误的问题。
- [x] 明确区分会话语义：VIS Archive 仅使用本地 `hiddenThreadIds`，可恢复；VIS Delete 调用 Codex 原生 `thread/archive`，不可通过 VIS 恢复，且不暴露或调用原生 `thread/unarchive`。
- [x] 加固多后端生命周期：OpenCode、Codex 与 ACP 之间切换时同时断开 UI 与 registry 持有的 Codex adapter，取消通用 prompt/confirm 与请求窗口，并阻止旧连接、旧线程或旧 backend 的异步结果和操作写入当前状态。
- [x] 修复 Status Monitor 的 MCP 与 Token 长期停留在“加载中”问题：MCP 状态请求超时后回退到已配置状态，`-32601` 明确显示“不支持”；Token 使用独立 loading，并阻止旧会话、旧后端与旧刷新结果覆盖当前状态。
- [x] 按 Codex app-server 的真实 MCP wire 数据归一化 `serverInfo`、`tools`、`resources`、`resourceTemplates` 与 `authStatus`，区分已连接、需要认证、已配置但连接状态不可用及已禁用状态。
- [x] 修复插件状态解析：`plugin/list` 的插件实际嵌套在 `marketplaces[].plugins[]` 中，并使用 `installed`、`enabled`、`availability` 与 `interface` 字段；`DISABLED_BY_ADMIN` 不再误报为可用或启用。
- [x] 完善 Status Monitor 的可访问性与多语言终态显示，补齐 tablist 键盘导航、ARIA 关联、MCP toggle 焦点状态、减少动画偏好及中日韩文本排版。

### OpenCode 后端修复

- [x] 修复原生 OpenCode 会话归档后仍被 TopPanel 当作活动会话的问题：将 canonical `SessionState.timeArchived` 投影为 `archivedAt`，使归档标记、恢复操作与活动会话过滤同步生效，并加入回归测试。
- [x] 修复子代理名称与历史刷新后消失的问题：从根线程的 task 记录提取实际子会话 ID，由 SharedWorker 以最多 2 个请求并发精确水合并校验同目录、直接父子关系，不再为恢复历史加载整个目录的全部子会话。
- [x] 修复子代理入口和历史窗口不遵循活动主题的问题：入口行、窗口外壳、历史条目、工具徽章及状态全部改用 floating、status 与 tool 语义主题令牌。
- [x] 修复子代理历史中的 edit、multiedit、read、Web Search、Web Fetch 与思考详情无法打开的问题；统一 `toolRenderers` 的工具详情渲染路径，并兼容 OpenCode 实际 wire 名 `websearch_web_search_exa`。

### OpenCode 冷启动性能优化

- [x] OpenCode 冷启动改为拓扑优先：SharedWorker bootstrap 只加载项目/目录拓扑，目录会话按 unloaded/loading/loaded/error 独立水合，首个有效选择后以最多 2 个目录并发后台补齐完整会话树。
- [x] 登录目标按"显式链接 → 按 server URL 隔离的持久化选择 → 当前 worktree → 首个项目 worktree"确定；持久化目标失效时清除记录并安全降级，显式目标不存在时提示 not-found 且不会误建会话。
- [x] 目录未加载（unloaded/loading/error）不再被当作空目录；只有加载完成的空目录才允许在指定目录创建一个新会话。
- [x] UI Ready 提前到目标会话可选中即完成；文件树、git status、命令、权限与问题改为后台异步加载，不再阻塞登录。


## [v0.6.0 released]

### 新后端支持(alpha)

- [x] 重构了后端adaptor体系，将其从App.vue中抽出，便于接入新的后端
- [x] “协作模式”本质上就是plan/default模式切换，应该做到输入框左下角agent切换那里
- [x] 删除“外部代理配置”
- [x] 完善“反馈”的格式
- [x] codex panel的“插件”功能可用于安装卸载插件
- [x] 修改“应用（app）”的翻译为“连接器（connector）”
- [x] 状态监控面板的 skills 标签支持启用/禁用 toggle（复用 MCP 模式，调用 Codex `skills/config/write` RPC）
- [x] 启用 Codex adapter 的 `experimentalApi` capability，使 `collaborationMode/list` 等实验性 RPC 可用
- [x] status monitor面板支持显示codex插件
- [x] forgecode panel 迭代与修复
	- [x] 添加forge panel，用于以pty+辅助gui的形式与forgecode zsh交互
    - [x] 设置里增加panel按钮的开关（类似codex panel）
    - [x] 按钮位置移到管理模式的右侧；将codex panel的按钮移到forge panel的右侧
    - [x] 修复pty终端的光标位置跟随不够智能的问题，现在经常出现光标在下方但滚动条滚不过去，或者光标在上方但是滚动条滚到底部的问题
    - [x] 侧边栏支持伸缩和隐藏，删除会话按钮，让侧边栏本身支持:new :clone :conversation :conversation-rename :conversation-tree :delete
    - [x] 输入框放到底部。输入框增加agent/功能选择器：forge muse sage suggest commit-preview
    - [x] 增加config控制按钮和子菜单，支持:config :config-edit :config-model :config-reload :config-commit-model :config-suggest-model :config-reasoning-effort
    - [x] 增加临时设置控制按钮和子菜单，支持:login :logout :model :reasoning-effort
    - [x] 增加状态显示按钮和二级弹出悬浮窗，同时增加显示:info的model信息和:tools :skill :workspace-info
    - [x] 增加工作区按钮和子菜单，支持:workspace-sync :workspace-init
    - [x] 增加对话操作按钮和子菜单，支持:compact :copy :edit :retry


### Bug 修复

- [x] 修复了在opencode和codex后端之间切换的不同步问题
- [x] 修复了状态监控面板在 OpenCode 和 Codex 后端之间切换时不随之刷新的问题（缺 `activeBackendKind` prop / watcher）
- [x] 修复了编辑器的“当前行指示器”不遵守主题设置的问题
- [x] 修复了codex后端下ai发送的消息会另起一个消息框的问题
- [x] 修复了codex后端下用户发送的消息会重复两遍的问题
- [x] 修复了codex后端下webserch webfetch会显示在ai输出中的问题
- [x] 修复了codex后端下混杂edit和multiedit的问题
- [x] 修复了codex后端下ai的输出导致严重页面跳动的问题 
- [x] 修复了codex后端下不显示历史记录的问题
- [x] 修复了codex后端下用户发送的新消息会混入上一条消息，以及会被上一条消息混入的问题
- [x] 修复了 Codex 后端下协作模式 (`collaborationMode`) 在 adapter 层被静默丢弃的问题（用户选择 agent 实际未生效，调用链 4 站中断在 `startTurn()`）
- [x] 修复了 Codex 后端下刷新页面时线程历史丢失、只剩最新 turn 的问题（`useBackendSessionReload` 中 `msg.reset()` 与桥接 watcher 的竞态，仅在真正切换 session 时才允许重置）
- [x] 修复了 Codex 后端下 agent 选择器显示空白的问题（`collaborationMode/list` 响应字段是 `mode` 而非 `id`，TS 类型与 wire 数据不匹配；按实测 wire 数据修正）
- [x] 修复了 Codex 后端下禁用 skills 后 `$` 弹窗仍然显示已禁用 skill 的问题（`updateSkill` 成功后未同步共享 `codexApi.skills.value`）
- [x] 但是其仍然不能实际投入使用，因为存在许多问题：详见[RoadMap.md](./RoadMap.md)

### 无法实现功能

- [x] 由于codex appserver自身的问题，无法实现以下功能：
   - [无法支持] 会话级别的token消耗显示
  - [无法支持] status monitor面板支持显示codex插件
         

## [v0.5.4 released]

### 编辑器集成(beta)

- [x] 实验性功能：嵌入CodeMirror6代码编辑器，支持在codex和opencode后端通过vis_bridge的/fs/writeFile http节点在web端编辑本地文件
- [x] 实现了完整的代码编辑器功能，适配了项目已有的字体设置和主题方案


### Bug 修复
- [x] 修复了对untracked files的统计导致的严重opencode server阻塞问题，该修复会导致git diff不再统计untracked files的行数，但仍然显示它的diff
- [x] 修复了“用编辑器打开”功能在codex后端不可用的问题
- [x] 修复了在codex后端关闭编辑器窗口时文件内容和diff不会自动刷新的问题

## [v0.5.1 released]

### 新后端支持(alpha)

- [x] 将codex app-server逐步接入vis前端，同时保留codex panel用于最小化使用/调试/与opencode并行使用。
	- [x] 文件树和文件管理：文件查看，文件预览，代码高亮，git diff，文件级别diff，git分支查看，文件搜索
	- [x] 远程终端和pty支持
	- [x] 会话树和会话管理：打开项目，创建新会话，发送消息，pin，归档，隐藏会话
		- [x] 全面模拟opencode后端的会话树表现
		- [x] 将“取消订阅”删除，“隐藏”映射到visui的“归档”，“归档”映射到visui的“删除”
	- [x] 输出面板与输出管理：显示模型输出内容，复制，撤销消息，创建分支
		- [x] 由于codex自身能力限制，不能创建基于tune的分支，只能创建基于整个thread的分支
	- [x] 提供商与模型管理
		- [x] 切换模型和思考强度，账号登陆与退出登录
		- [x] 支持codex cli的byok功能，支持第三方提供商（responses api），但是由于codex自身逻辑问题不是很稳定，建议谨慎使用多个自定义提供商
	- [x] 完善加载界面，实现分阶段加载显示
	- [x] 完善attach功能，支持上传图片
	- [x] 状态监控：codex面板
- [x] 但是其仍然不能实际投入使用，因为存在许多问题：详见[RoadMap.md](./RoadMap.md)

### 状态监控

- [x] 添加了"codex"面板，允许在已连接codex app-server时查询codex已使用额度（5小时）
- [x] 引入了预加载，在连接opencode服务器时即进行加载

### Bug 修复

- [x] 修复了“文件树”中的文件夹有概率在第一次打开时不显示文件，需要开关一次才会显示文件的问题
- [x] 修复了“文件树”中文件级别的diff刷新有很大的延迟的问题
- [x] 修复了“文件树”有小概率只显示前五个文件，需要刷新网页后才会恢复的问题
- [x] 修复了“输出面板”加载超大会话时，会有从上向下的滚动和试图维持在最新会话，但似乎有什么向上的力量导致的跳动，不能稳定在最新那条对话的问题
- [x] 修复了“输出面板”无法正确加载登录进来以后的第一个会话，必须手动刷新一次的问题

### 无法实现功能

- [x] 由于codex appserver自身的问题，无法实现以下功能：
	- [x] 支持完整的“/”命令

## [v0.4.5 released]

### Bug 修复

- [x] 修复了status monitor可能导致内存泄漏的问题
- [x] 修复了因上个修复导致status monitor打不开的问题

## [v0.4.3 released]

### Bug 修复

- [x] 修复了electron应用无法连接vis_bridge的问题
- [x] 修复了优化悬浮窗性能表现导致的悬浮窗卡顿问题
- [x] 修复了悬浮窗系统可能存在的漏洞
- [x] 修复了手动修改文件不触发文件树刷新的问题

## [v0.4.1 released]

### 性能优化

- [x] 为输出面板引入虚拟滚动，降低大会话滚动开销
- [x] 加速输出面板和文件树的lazyloading，减少加载时间
- [x] 尝试优化悬浮窗弹出时的性能表现，降低低端设备的卡顿

### 新后端支持(alpha)

- [x] 添加了vis_bridge，用于转发codex app-server json-rpc的轻量桥接器
- [x] 添加了codex panel，一个基于codex app-server api的最小化悬浮窗面板
- [x] 在“设置”中添加了“实验性功能”，允许打开codex panel

### Critical Bug 修复

- [x] 修复了禁用provider会导致所有提供商全部消失的bug

### 提供商与模型管理

- [x] 修改了提供商与模型管理面板的ui设计
- [x] 完善供应商与模型管理功能，支持所有提供商的web端连接，支持自定义提供商连接
- [x] 补全了提供商与模型管理面板的i18n支持

### 开始界面

- [x] 移除了过时的使用方式说明

### Bug 修复

- [x] 修复了自动换行导致的行号可能在最右边的问题
- [x] 修复了禁用模型功能无效的问题
- [x] 修复了“设置”和“提供商与模型”在失去鼠标焦点时会自动关闭的问题
- [x] 回滚了之前错误删除的文件树更新逻辑
- [x] 回滚会话内容懒加载，以解决加载跳动问题
- [x] 修复diff界面不显示新创建文件夹下的文件的问题

## [v0.3.0 released]

### 悬浮窗管理

- [x] 悬浮窗支持预览.ico文件的图片
- [x] 悬浮窗支持预览可执行二进制文件和损坏的二进制文件的信息和hexdump
- [x] 悬浮窗支持高亮生物信息学相关文件：
	- FASTA (.fasta, .fa, .fna, .faa)
	- FASTQ (.fastq, .fq)
	- SAM (.sam)
	- VCF (.vcf) 
	- BED (.bed)
	- GTF/GFF (.gtf, .gff, .gtf3)
- [x] 为悬浮窗hexdump预览增加虚拟滚动功能，降低性能开销
- [x] 为Shiki语法高亮补全了大量可高亮的语言

**新增语言映射**:
| 扩展名 | Shiki语言ID |
|--------|-------------|
| `.cjs`, `.mjs` | `javascript` |
| `.svelte` | `svelte` |
| `.astro` | `astro` |
| `.json5`, `.jsonc` | `json` |
| `.mdc`, `.mdx` | `markdown` |
| `.htm` | `html` |
| `.sass` | `sass` |
| `.less` | `less` |
| `.bash`, `.zsh` | `shellscript` |
| `.pyw` | `python` |
| `.h`, `.hpp`, `.hh` | `cpp` |
| `.cs` | `csharp` |
| `.erb` | `ruby` |
| `.pl`, `.pm` | `perl` |
| `.lua` | `lua` |
| `.dockerfile` | `dockerfile` |
| `.mk`, `.mak` | `makefile` |
| `.gql`, `.graphql` | `graphql` |
| `.regex`, `.regexp` | `regex` |
| `.coffee`, `.coffeescript` | `coffee` |
| `.r` | `r` |
| `.jl` | `julia` |
| `.wasm` | `wasm` |
| `.wgsl` | `wgsl` |
| `Makefile` | `makefile` |
| `Dockerfile` | `dockerfile` |

### 主题设置（Beta）

- [x] 支持自定义不同功能的悬浮窗颜色和透明度
- [x] 支持自定义shell（xterm.js）背景颜色和透明度
- [x] 扩展schema语义以支持上述的自定义功能

### 编辑器集成

- [x] 支持了在关闭$EDITOR对应的shell窗口后，悬浮窗预览内容自动刷新

### Bug 修复

- [x] 修复了空心圆点在linux平台上和其他平台渲染效果不一致的问题
- [x] 修复了diff界面可能存在信息为全空的项的问题
- [x] 修复了electron开发在windows上报错的问题
- [x] 修复了electron打包应用中“复制”按钮失效的问题
- [x] 修复了被删除的文件在刷新后仍然显示在文件树中的问题

### 上游问题

- [x] 已经验证数项上游问题，这些预览在Vis前端已经支持，但无法实际使用
	- [x] OpenCode serve 的/file/content api对pdf文件返回空的二进制，导致无法预览
	- [x] OpenCode serve 的/file/content api对压缩文件返回空的二进制，导致无法预览
	- [x] OpenCode serve 的/file/content api会将icns文件以plain text形式返回，损坏原始信息，导致无法预览

## [v0.2.0 released]

### 国际化 (i18n)

- [x] 添加繁体中文（台湾用语）翻译，覆盖全部界面文本
- [x] 添加日语翻译，覆盖全部界面文本
- [x] 添加世界语（Esperanto）翻译，覆盖全部界面文本

### 字体管理（Beta）

- [x] 允许设置终端字体大小、代码视图字体大小、消息字体大小、界面字体大小

### 状态监控

- [x] 实时显示当前会话的 Token 使用情况，包括模型上下文限制、输入/输出/推理 Token 数量、缓存命中、使用率百分比进度条
- [x] 状态监控面板支持横向滚动，解决按钮过多导致的布局溢出

### 悬浮窗管理

- [x] 支持在设置中开启/关闭悬浮窗预览自动换行，防止长行代码影响阅读（适用于文件预览、edit/write/patch、git diff 等所有带行号的悬浮窗）

### 会话管理增强

- [x] 将现有的单会话级会话侧边栏改为基于项目-沙盒-会话的三层级会话树侧边栏(beta)
- [x] 修改了顶部会话栏的样式，使其与其他位置风格统一
- [x] 实现重命名会话功能

### 标识设计

- [x] 为electron应用打包提供icon

### 主题设置（Beta）

- [x] 全面弃用window.prompt和window.confirm，改用自定义控件以适配主题


### Bug 修复

- [x] 修复 `grep` 工具"模式"信息的字符样式被主题错误覆盖的问题
- [x] 修复对话级别"差异"只显示 diff、不显示 before/after 的问题
- [x] 修复 `/` 快捷命令下拉列表被限制为仅显示 8 条内容的问题，现在显示全部匹配命令
- [x] 修复 `@` 快捷命令在选择代理后会再次触发弹窗的问题
- [x] 修复所有输入框在用户输入过程中应用上下限限制，导致输入过程被截断的问题
- [x] 修复后台hydration过慢的问题，改善加载速度
- [x] 修复顶部栏每个sandbox只能显示五条session的问题
- [x] 修复顶部栏的标题有可能会换行的问题


## [v0.1.0 released]

### 国际化 (i18n)

- [x] 完整 i18n 框架支持
- [x] 添加简体中文翻译，覆盖全部界面文本

### 字体管理（Beta）

- [x] 允许设置 Shell 终端字体
- [x] 允许设置界面等宽字体
- [x] 实现系统字体自动发现功能（依赖浏览器 API）
- [x] 实现字体命中情况确认功能

### 供应商与模型管理（Beta）

- [x] 允许查看现有和全部供应商列表
- [x] 允许查看、启用、禁用现有模型（仅限本地，无法同步到服务端）

### 状态监控

- [x] 允许查看服务器状态
- [x] 允许查看 MCP 服务器状态
- [x] 允许查看 LSP 状态
- [x] 允许查看 Plugin 状态
- [x] 允许查看 Skills 状态
- [x] 允许关闭 MCP 服务器连接

### 主题设置（Beta）

- [x] 支持自定义每一块卡片的不同区域和不同组件的颜色
- [x] 支持导入自定义主题
- [x] 支持自定义主题格式schema

### 编辑器集成

- [x] 添加"用编辑器打开"功能，允许使用系统的 `$EDITOR` 环境变量打开文本文件

### 代码行评论

- [x] 添加"代码行评论"功能
- [x] 支持鼠标拖拽选择代码范围
- [x] 支持将评论内容附加到输入框

### 会话管理增强

- [x] 添加 Session Pin 功能，在侧栏增加 Sessions 面板
- [x] 允许将常用 Session Pin 在侧边栏快速访问
- [x] 添加批量管理功能，在顶栏增加 Management 按钮
- [x] 支持多选 Session 进行批量操作
- [x] 添加取消归档功能，允许找回已归档的 Session

### 悬浮窗管理

- [x] 为所有悬浮窗添加关闭和最小化按钮
- [x] 允许手动隐藏和最小化所有悬浮窗
- [x] 支持关闭自动最小化功能
- [x] 添加底部 Dock 栏，用于存放最小化后的悬浮窗

### 快捷命令

- [x] 添加对 `@` 快捷命令的支持，用于显式召唤代理

### 性能优化

- [x] 对超大 Session 列表实现懒加载 (Lazy Loading)，显著降低卡顿
- [x] 对超多 Session 实现后台 Hydration，加快冷启动速度
- [x] 清理冗余代码，减少包体积

### 桌面应用

- [x] 支持将 Web UI 打包为跨平台桌面应用（Windows / macOS / Linux）
- [x] 基于 Electron 框架，支持独立应用窗口、安全沙箱与系统浏览器外链跳转
- [x] 开发模式自动检测 `127.0.0.1:5173` 并拉起 Vite 预览服务
- [x] 桌面端持久化存储通过主进程写入 `renderer-storage.json`，解决自定义主题、设置、服务器地址在重新安装或多窗口场景下丢失的问题

### 基础设施

- [x] 修改默认端口为 `23003`，减少在 WSL 上与 Windows 服务的端口冲突
- [x] Vite 开发服务器固定绑定 `127.0.0.1:5173`（`strictPort: true`），避免 `localhost` 解析到 `::1` 导致 Electron 连接失败

### Bug 修复

- [x] 修复输入栏层级过高覆盖悬浮窗的问题
- [x] 修复 Windows 上部分界面行为与 Web 端不一致的问题
- [x] 修复多数模型无法 attach 文件的问题（改为默认允许所有模型 attach）
- [x] 修复悬浮窗最小化和关闭按钮样式受字体影响而显示异常的问题





---

## 上游原始功能

以下功能由上游 [xenodrive/vis](https://github.com/xenodrive/vis) 提供，本 fork 完整保留：

- 以审阅为核心的悬浮窗口，保持工具输出和智能体推理的上下文
- 支持多项目和工作树的会话管理
- 内置语法高亮的代码和 diff 查看器
- 交互式智能体工作流的权限和问题提示
- 基于 xterm.js 的嵌入式终端

---

> 🗺️ **路线图与未来计划**：请参阅 [RoadMap.md](./RoadMap.md)
