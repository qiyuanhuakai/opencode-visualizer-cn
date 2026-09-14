# OMO App Server（senpi）

## VIS 适配预备与运行时差异（2026-09-14）

本节依据 OMO 内置官方文档（本机安装 `omo-ai@5.0.0-0.beta.62` → `@code-yeongyu/senpi@2026.9.13`，`node_modules/@code-yeongyu/senpi/docs/app-server.md` 与 `app-server-daemon.md`，原文保留在下方"官方文档参考"）补充，并与本机 **senpi app-server 2026.9.13** 的真实 JSON-RPC 响应交叉验证（实测环境：WSL2，2026-09-13 首轮探针 + 2026-09-14 完整 turn/重启重建/归档/多客户端专项探针，`omo app-server --listen ws://127.0.0.1:<port>`，Bearer token 握手）。下文保留协议参考；文档描述、生成的类型存在，并不代表当前服务的实现支持该能力。

### 实现定位

- OMO 的 codex app-server 支持是 senpi 引擎对 Codex app-server 协议的**完整重实现**（不是代理）。`omo app-server` 由 omo-ai native 版透传到 senpi 的 app-server 模式；OMO 4.x stable（opencode 插件系）没有此能力。
- 协议类型定点生成自 Codex git checkout，非已发布的 codex-cli 版本。senpi 自身文档对定点 commit 表述不一致：`docs/app-server.md` 称 `0fb559f0`（2026-07-18），引擎内 `AGENTS.md` 称 `9fc715c`（2026-07-22）。不以定点 commit 断言行为，以实测为准。
- senpi 自带与真实 Codex app-server 并排运行的帧级 differential parity harness（官方文档参考末节），兼容目标为逐帧对齐。

### 启动、传输与鉴权

- 启动命令：`omo app-server --listen ws://127.0.0.1:<port>`（等价于 `senpi app-server`）；省略 `--listen` 时默认 `stdio://`；另支持 `unix://` 与 `unix:///abs/path`。常驻形态：`omo app-server daemon start`，默认监听 `ws://127.0.0.1:18800`，支持 `status/stop/restart`。
- WebSocket 监听**只绑定 IP 字面量主机**；`localhost` 等主机名不可用（官方文档）。
- **鉴权是与官方 Codex 最大的集成差异**：官方 Codex 的 loopback 监听默认无鉴权（`--ws-auth` 取的是模式，仅供非 loopback 使用）；senpi **loopback 同样默认强制 Bearer**。省略 `--ws-auth` 时自动创建/复用 token 文件 `${OMO_CODING_AGENT_DIR:-~/.omo/agent}/app-server/ws-token`，并把路径打印到 stderr（实测）。`--ws-auth <path>` 指定 token 文件；`--ws-auth off` 仅允许 loopback。
- 同一监听提供 HTTP 健康探测：`GET /readyz` 与 `GET /healthz` 返回 `ok\n`（实测 `/readyz`）。HTTP `Origin` 头的升级请求被拒绝；出向背压超限的客户端以 `1013` 关闭（官方文档）。
- VIS 侧复用点：bridge 的 `codexWebSocketProxy.js` 已具备上游 `Authorization` 注入通道（`--upstream-token`）；接入 OMO 时 token 从上述 token 文件读取，不要走 `--ws-auth off`。

### 握手与后端身份

实测（2026-09-13，senpi 2026.9.13）：

| 项目 | 实测结果 |
| --- | --- |
| 未 initialize 先发 `model/list` | `-32600`，`Not initialized`（官方文档写 `-32000`，文档漂移，以线上为准） |
| `initialize`（`experimentalApi:true`） | 成功，响应见下 |
| 重复 `initialize` | `-32600`，`Already initialized`（官方文档同样误写 `-32000`） |
| 全程未发送 `initialized` 通知 | 所有后续请求正常——senpi 在 `initialize` 请求成功时即置位，`initialized` 通知不是必需（VIS 照发无害） |

`initialize` 实测响应：

```json
{"id":2,"result":{"userAgent":"vis-probe/2026.9.13 (Linux 6.18.33.2-microsoft-standard-WSL2; x64) senpi_app_server","codexHome":"/home/qiyuaner/.omo/agent","platformFamily":"unix","platformOs":"linux"}}
```

- `userAgent` 形态为 `<clientInfo.name>/<senpi 版本> (<OS>; <arch>) senpi_app_server`。VIS 现有按 `^[^/\s]+\/([^\s(]+)` 提取版本的逻辑会把 senpi 版本（如 `2026.9.13`）误当 Codex 版本；**必须先以 `senpi_app_server` 标记识别后端身份**，senpi 版本号与 Codex 版本门不可比较。
- `codexHome` 指向 `${OMO_CODING_AGENT_DIR:-~/.omo/agent}`，不是 `~/.codex`。

### 方法支持面

完整支持/不支持清单以"官方文档参考"中的两张方法表与 `-32601` 表为准。对 VIS 现有适配层的重点：

实测可用：`initialize`、`model/list`（37 个已配置模型，camelCase，含 `supportedReasoningEfforts`/`defaultReasoningEffort`/`isDefault`）、`config/read`（子集）、`account/read`、`thread/list`（含 `nextCursor` 与 `backwardsCursor`）、`thread/start`、`thread/read`（`includeTurns:true`）、`thread/turns/list`、`turn/start`、`thread/archive`、`thread/delete`。
实测 `-32601`：`command/exec`、`getAuthStatus`（与官方文档的故意 `-32601` 表一致）。

VIS 当前会调用、而 OMO **故意 `-32601`** 的方法（摘自官方表，适配时必须能力门控）：

- 账户与登录：`account/login/start`、`account/login/cancel`、`account/logout`、`getAuthStatus`、`account/workspaceMessages/read`、`app/list|read|installed`。
- 直接文件系统与命令：`fs/*` 全部、`command/exec*` 全部、`gitDiffToRemote`。
- 配置写入与扩展管理：`config/batchWrite`、`config/value/write`、`config/mcpServer/reload`、`experimentalFeature/enablement/set`、`plugin/*`、`skills/config/write`、`skills/extraRoots/set`、`hooks/list`。
- 其他：`review/start`、`mcpServer/tool/call`、`mcpServer/resource/read`、`mcpServer/oauth/login`、`modelProvider/capabilities/read`、`externalAgentConfig/*`、`feedback/upload`、`thread/rollback`、`thread/shellCommand`、`thread/inject_items`、`thread/backgroundTerminals/*`、`thread/turns/items/list`（Codex HEAD 已退役）、`process/*`、`memory/reset`、`thread/realtime/*`、Windows 专属项、remoteControl 注册流。

**诚实错误**（实现了但返回业务错误，不是 `-32601`）：`account/rateLimits/read`、`account/usage/read`（需要 Codex 账户，返回 invalid-request）；`remoteControl/client/list`（无 remote-control 句柄，internal error）。VIS 的能力探测分类逻辑（`-32601→unsupported`、`-32600→gated/错误`）可直接复用，但要预期这两类方法的 `-32600` 是**永久业务错误**，不是实验门控。
**部分支持**：`thread/settings/update` 仅接受 session 级 `model` 与 `effort`，其他字段报 invalid-request。

### 历史语义差异（适配核心）

- senpi 的 turn 历史保存在**进程内 TurnLog**：进程存活期间 idle unload/resume 不丢历史；**进程重启后只能有损重建为仅含用户消息的 turn**（官方文档明确）。VIS 不能把 OMO 后端的历史当作持久完整历史，展示策略需另行实测确认。
- 新建线程首发前实测为（对比 docs/codex.md 的 0.153.4 表）：

| 请求 | Codex 0.153.4 实测 | senpi 2026.9.13 实测 |
| --- | --- | --- |
| `thread/read`，`includeTurns: true` | `-32601`，`list_turns is not supported yet` | **成功**，`turns:[]` |
| `thread/turns/list`，`itemsView:"full"` | `-32600`，`not materialized yet` | **成功**，`{"data":[],"nextCursor":null,"backwardsCursor":null}` |
| `thread/read`，`includeTurns: false` | 成功 | 成功（未单独实测，同形态） |

  即 OMO 上不存在 Codex 的"未物化"错误族；VIS `errors.ts`/`history.ts` 的降级链不会触发，主路径可直接走 `thread/turns/list`。
- **`historyMode` 参数与字段在 senpi 中不存在**：传入被静默忽略，响应中也没有 `historyMode`。VIS 不得按 Codex 的 `historyMode:"paginated"` 分支处理 OMO 连接。

有效模型（`kimi-coding/k3`）完整 turn 实测（2026-09-14）：

- turn 的 item 序列：`userMessage` → `reasoning` → `agentMessage`；`thread/read(includeTurns:true)` 与 `thread/turns/list(itemsView:"full")` 返回同一完整集合。
- `reasoning` item：id 形如 `msg_<id>:0`，`summary:[]`、`content:[]` 起步，流式经 `item/reasoning/textDelta`（`{itemId, delta, contentIndex}`），完成时 `content` 数组带完整推理文本。
- `agentMessage` item：id 形如 `msg_<id>:1`，字段 `text`/`phase`/`memoryCitation`，流式经 `item/agentMessage/delta`（`{itemId, delta}`），完成时 `text` 为完整正文。
- `userMessage` content 元素为 `{"type":"text","text":"...","text_elements":[]}`；`item/started` 带 `startedAtMs`、`item/completed` 带 `completedAtMs`（毫秒）。
- 模型返回空内容时（实测 devin/swe-1-6 持续零 token 响应），turn 以 `completed` 收尾且 **items 只含 userMessage、error 为 null**——"成功但无输出"是合法终态，VIS 不能把它当错误，也不能据此清空界面。

app-server 进程重启后的历史重建实测（2026-09-14，对上述含 reasoning 的完整 turn 重启后重读）：

| 项目 | 重启前 | 重启后 |
| --- | --- | --- |
| turn id | 原始 UUID（如 `3f5e411d-…`） | **合成 id `turn-1`**——turn id 跨重启不稳定 |
| `userMessage` | 保留 | 保留（文本完整） |
| `reasoning` item | 保留 | **丢失** |
| 最终 `agentMessage` | 保留 | 保留（文本完整） |
| 隐藏提示词产生的 turn（见"通知"节） | 独立 turn | 其 agentMessage **合并进**重建的 `turn-1` |
| `thread/items/list` | `{turnId, item}` 包装 | 同左；`backwardsCursor` 为内含 anchor 的 JSON 字符串 |

官方文档称重建"仅含用户消息"，实测保留了最终 agent 文本、丢 reasoning；以实测为准。VIS 对 OMO 后端的历史展示应按"重启后 reasoning 不可得、turn id 会变化"设计，不得跨进程缓存 turn id 映射。

### 归档与删除语义

2026-09-14 实测 + 源码定位（senpi 2026.9.13，`dist/modes/app-server/threads/archive-state.js`、`handlers.js`、`list-handlers.js`）：

- `thread/archive` = 卸载线程 + 在会话文件旁写入 sidecar `<sessionPath>.archived`（单行 JSON `{archivedAt, thread}`）。默认 `thread/list` 通过逐线程 `isArchived`（精确路径检查）过滤，归档线程从列表消失——这一半功能正常。
- **归档线程不可恢复（实现 bug）**：`thread/unarchive` 与 `thread/list(archived:true)` 都走 `listArchivedThreads()`，它只 `readdir` 顶层 sessions 目录，而 sidecar 实际写在按 cwd 分桶的子目录（`sessions/--<cwd>--/`）里。因此 `thread/list(archived:true)` **永远返回空**、`thread/unarchive` **永远返回 `-32600 thread not found`**（磁盘上 sidecar 完好、静置 24 小时后重试依旧；已排除时序竞争）。
- `thread/delete` 对**普通线程**：返回 `{}` 并删除会话 `.jsonl`；但 `-artifacts` 目录残留（文档称连带 sidecar 删除，实测 artifacts 目录不删）。
- `thread/delete` 对**归档线程**：返回 `{}` 但**什么都不删**（归档线程对 delete 同样不可见，sidecar 与 artifacts 全部残留）——静默成功-no-op。

对 VIS 的含义：在 senpi 修复该 bug 之前，OMO 后端的原生 `thread/archive` 实际是**不可恢复的移除**（列表隐藏 + 无法 unarchive + delete 不可达，只剩磁盘 sidecar）。这与 Codex 后端"native archive = Delete"的既有语义在效果上接近，但成因不同（Codex 是设计如此，OMO 是实现缺陷）；VIS 若映射 Delete 动作到 `thread/archive`，应同时在文档/UI 标注 OMO 上不可恢复，且不得提供"取消归档"入口。版本升级后需按"复测方法"重新验证本表。

### 多客户端与并发控制

2026-09-14 双 WebSocket 客户端实测：

- 同一线程的多个订阅连接**都能收到** thread 级通知（`turn/started`、`item/*`、`turn/completed`、`error`），广播无丢失。
- `thread/unsubscribe` 只摘除调用方连接（响应 `{"status":"unsubscribed"}`）；其余订阅者不受影响，被摘除方不再收到该线程任何通知。
- 线程有活动 turn 时再发 `turn/start`，返回 `-32603`：`Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`——OMO 上"线程忙"是显式错误而非排队；VIS 的续发/队列逻辑必须处理此错误并改用 `streamingBehavior` 参数。注意 OMO 存在后台自发 turn（见下节），即使前端未发消息也可能撞上该错误。
- 失败 turn 的通知形态：`error` 方法通知（`{threadId, turnId, error:{message, codexErrorInfo, additionalDetails}, willRetry}`）+ `turn/completed(status:"failed")`，二者都会广播给全部订阅者。

### 配置与账户姿态

- `config/read` 只暴露 5 个有映射的键（实测）：`model`、`model_provider`、`approval_policy`（恒 `"never"`）、`sandbox_mode`（恒 `"danger-full-access"`）、`model_reasoning_effort`；`origins`/`layers` 随 `includeLayers` 返回，project 层目录名为 `.omo`。一切配置写入 `-32601`。
- `approvalPolicy` 恒 `"never"` + sandbox 恒 `dangerFullAccess`（`thread/start` 实测响应确认）意味着审批请求实际不会触发；VIS 的审批交互在 OMO 后端应按休眠处理。
- `account/read` 实测返回 `{"account":null,"requiresOpenaiAuth":false}`（无本地凭据时；有凭据时为 `{account:{type:"apiKey"}}`）。登录/登出方法全部 `-32601`，VIS 的登录 UI 必须按运行时能力门控。

### 时间戳与字段大小写

- thread/turn 的 `createdAt`/`updatedAt`/`recencyAt`/`startedAt`/`completedAt` 为**浮点秒**（实测 `1789306592.884`）；`durationMs`、通知的 `emittedAtMs`、item 的 `startedAtMs`/`completedAtMs` 为**毫秒**。VIS `wireTimestampMs` 的 `<1e12` 视为秒启发式与此兼容。
- 线协议主体 camelCase；`config/read` 键 snake_case（`model_provider` 等，与 Codex 相同）；item content 内混有 snake_case 字段 `text_elements`（实测 `{"type":"text","text":"...","text_elements":[]}`）。

### 通知

- 所有通知带 `emittedAtMs`（毫秒）；通知可先/中/后于关联响应到达（实测 `thread/started` 先于 `thread/start` 响应一毫秒）。
- senpi 特有 `extension_event` 通知（实测收到 `terminal_monitor_state`），无条件发给已订阅连接；VIS 需按未知通知容忍。
- **服务端自发 turn 真实存在且有两类来源**（2026-09-14 实测 + 源码定位）：
  1. **隐藏提示词注入**：后台事件以 `custom_message`（`display:false`）注入会话并触发 turn。实测捕获 `senpi-terminal:notification`（终端监视器通知，源码 `core/extensions/builtin/terminal/notify.js`：`triggerTurn:true`，`deliverAs` 为 `steer`/`followUp`）；模型可用时产生含真实 agentMessage 的完整 turn。
  2. **空响应自动重试**：模型返回空内容时（实测 devin/swe-1-6 持续零 token），senpi 的 stop-hook（会话日志中的 `senpi.hooks.stop-state` 条目）以递增间隔（约 3s/5s/10s…）自动重试同一逻辑 turn，**每次重试在线上都是一个全新的独立 turn**（新 turnId、`turn/started`→`turn/completed`、items 为空），实测连续出现 6 个；重试期间线程忙碌，`turn/start` 会撞 `-32603`。期间还可能看到 `error` 通知（`Prompt preflight failed`，`willRetry:false`）与内置扩展的 `extension ctx is stale` 错误通知。
  
  VIS 必须按 turnId 独立处理每个 turn，容忍一条用户消息后跟随多个空 turn 或无客户端输入的 turn，不得假定 turn 一定由自己的 `turn/start` 产生。
- 无订阅者时终结通知（`turn/completed`、`error`）按线程排队（上限 100）并重放给下一个订阅者；`turn/diff/updated` 是 senpi 投影的累积 diff，不是 Codex 的 git 基 diff；双方都不发 `thread/compacted`。
- `thread/search` 默认 source 过滤为交互式（`cli`/`vscode`），app-server 创建的线程必须显式传 `sourceKinds:["appServer"]`。

### VIS 适配落点（预备结论）

1. 服务定义：`bridge/processSupervisor.js` 的 codex 定义（L18-24）旁增加 OMO：`command:'omo'`、`args:['app-server','--listen','ws://127.0.0.1:<独立端口>']`；probe 可升级为 HTTP `/readyz`。
2. 鉴权：`codexWebSocketProxy.js` 复用现有上游 `Authorization` 注入；token 读 `${OMO_CODING_AGENT_DIR:-~/.omo/agent}/app-server/ws-token`。
3. 后端识别：`initialize.userAgent` 以 `senpi_app_server` 结尾判定 OMO；版本门控逻辑先行短路。
4. 能力门控：按运行时探测（复用 `capabilityRegistry` 的 `-32601/-32600` 分类）关闭登录、fs/命令、配置写入、插件、审批等入口；`account/rateLimits/read` 与 `account/usage/read` 的 `-32600` 视为永久不可用。
5. 历史路径：OMO 直连 `thread/turns/list`；不启用 `historyMode` 分支；进程重启后的有损历史展示策略待实测。
6. 归档映射：OMO 原生 `thread/archive` 当前不可恢复（见"归档与删除语义"节），可映射到 VIS 的 Delete 动作并标注不可恢复；不提供取消归档入口；版本升级后复测。
7. `BackendKind` 与 `backendRequestFence` 需扩出 OMO 身份（或在 codex 适配器上加 flavor 参数）。
8. 遵守 docs/codex.md 的既有要求：协议新方法必须另行验证实际能力后再暴露 UI，不按本文清单自动启用。

### 剩余未实测项

以下尚未实连线验证，适配涉及对应功能时须先补测（复测方法见下）：

- idle 超时自动 unload 的时长的与行为（官方文档描述：无订阅者且无活动 turn 后卸载；本次未等待验证）。
- `thread/search`、`thread/searchOccurrences`、`fuzzyFileSearch` 系列的结果形状。
- `skills/list`、`mcpServerStatus/list`、`permissionProfile/list`、`experimentalFeature/list` 的内容形状。
- 审批流（`item/commandExecution/requestApproval` 等）与 `item/tool/requestUserInput`——当前权限姿态下实际不触发，仅在 senpi 改变固定姿态后才需要。
- `turn/steer`、`turn/interrupt` 对活动 turn 的实际效果（本次自发 turn 均为秒级完成，未拦截成功）。
- 复测方法：`omo app-server --listen ws://127.0.0.1:<port>` 启动后，以 `Authorization: Bearer $(cat ~/.omo/agent/app-server/ws-token)` 握手，按本文各表逐项发 JSON-RPC 请求。升级 senpi/OMO 版本后，凡本文标注"实测"的结论都应复测，特别是归档语义（实现缺陷可能修复）与重启历史重建形状。

## 官方文档参考

以下为本机 `omo-ai@5.0.0-0.beta.62` 内置的 senpi 官方文档原文（`@code-yeongyu/senpi@2026.9.13`）。文中 `senpi app-server` 命令在 OMO 下等价于 `omo app-server`；状态目录 `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}` 在 OMO 下对应 `${OMO_CODING_AGENT_DIR:-~/.omo/agent}`（实测 token 创建于 `~/.omo/agent/app-server/ws-token`）。

---

# App Server Mode

App Server mode exposes Senpi as a Codex-compatible JSON-RPC server for app and editor integrations. See
[App Server Daemon](app-server-daemon.md) when the listener should be managed as a background process.

## Starting App Server Mode

Primary websocket recipe:

```bash
senpi app-server --listen ws://127.0.0.1:18990
```

The websocket listener binds only to IP literal hosts. When `--ws-auth` is omitted, Senpi creates or reuses a bearer
token file at `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}/app-server/ws-token`, prints that path to stderr, and
requires `Authorization: Bearer <token>` on websocket upgrades.

```bash
token="$(cat ~/.senpi/agent/app-server/ws-token)"
websocat -H "Authorization: Bearer $token" ws://127.0.0.1:18990/
```

Authentication options:

- `--ws-auth <path>` reads the bearer token from an explicit file.
- `--ws-auth off` disables bearer auth only for loopback websocket hosts.

For an embedded subprocess, use stdio:

```bash
senpi app-server --listen stdio://
```

`stdio://` is also the default when `--listen` is omitted. The command accepts `unix://` and
`unix:///abs/path` in the `--listen` grammar for local-control socket addresses, but this document does not cover
daemon lifecycle or control-socket management.

## Protocol Overview

App Server mode speaks JSON-RPC-shaped messages without a `jsonrpc` field. A request has `id`, `method`, and optional
`params`; a success response has `id` and `result`; an error response has `id` and `error`.

Clients must send `initialize` before any other request. Requests before initialization return `-32000 Not initialized`;
a second `initialize` returns `-32000 Already initialized`. A request marked experimental requires
`capabilities.experimentalApi: true`; without it, Senpi returns `-32600`. After initialization, methods in the
[Intentional `-32601` Surface](#intentional--32601-surface) return `-32601 Method not found` rather than a partial or
invented implementation.

All server notifications use the current Codex envelope and include `emittedAtMs`. Clients must tolerate notifications
before, between, and after correlated responses, except where a method explicitly guarantees response-before-notification
ordering below.

## Provider account display names

`account/providerAccounts/read` returns secret-free account descriptors with `name`, `source`, `blocked`, `pinned`, and optional `displayName`. Clients should render `displayName (name)` when present and the ID alone otherwise. Pins, removal, and comparisons must continue using immutable `name`, not the display label. Rename/clear operations are available through Senpi's account slash commands; no new app-server mutation method is introduced.

`displayName` is stored NFC-normalized with internal whitespace collapsed and is at most 32 terminal columns wide, so a client can render it inline without measuring; it is unique per provider under a fold of case, Unicode compatibility forms, invisible code points, and Cyrillic lookalikes.

## Protocol Provenance

The raw TypeScript fixture is pinned to Codex git
[`0fb559f0f6e231a88ac02ea002d3ecd248e2b515`](https://github.com/openai/codex) (author date 2026-07-18), not to a
published `codex-cli` package version. It is copied from:

```text
codex-rs/app-server-protocol/schema/typescript
```

Regenerate it from the source checkout with:

```bash
packages/coding-agent/scripts/generate-app-server-protocol.sh \
  --from-checkout /Users/yeongyu/local-workspaces/codex
```

`src/modes/app-server/protocol/generated/` is evidence only: it remains byte-identical to Codex except for the local
`package.json` compilation shim and is never a runtime dependency. Senpi's non-generated protocol facade is the runtime
contract. It also supplies selected experimental request types because Codex's TypeScript exporter intentionally omits
experimental request roots even though Codex serves them. See
[`src/modes/app-server/protocol/README.md`](../src/modes/app-server/protocol/README.md) for the vendoring and facade
rules.

## Framing

For `stdio://`, each message is one UTF-8 JSON object followed by LF (`\n`). stdout is reserved for protocol frames;
status and logs go to stderr.

For `ws://`, each websocket text frame is one JSON object. Binary frames are ignored. HTTP `Origin` headers are rejected,
`/readyz` and `/healthz` return `ok\n` while the listener is accepting connections, and websocket clients that exceed
outbound backpressure limits are closed with code `1013`.

## Live Examples

The examples in this section are checked against a fresh isolated stdio server by
`test/qa/app-server/task20-doc-example-check.ts`. Identifiers, timestamps, paths, and installed models naturally vary.
The isolated checker has no configured model, so its `model/list` example intentionally has an empty `data` array.

### initialize

Initialize the connection and declare client capabilities.

Request:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"task20-docs","title":"Task 20 Docs","version":"0.0.1"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
```

Response:

```json
{"id":1,"result":{"userAgent":"task20-docs/2026.7.2 (Darwin 25.4.0; arm64) senpi_app_server","codexHome":"/tmp/senpi-task20-docs/agent","platformFamily":"unix","platformOs":"macos"}}
```

`capabilities.experimentalApi` gates experimental requests and experimental notifications.
`capabilities.optOutNotificationMethods` may list notification method names the client does not want to receive.

### model/list

List configured models. `includeHidden`, a numeric cursor, and a minimum page size of one are supported. Model records
include Codex-compatible reasoning-effort, service-tier, and `isDefault` fields when a model is configured.

Request:

```json
{"id":2,"method":"model/list","params":{"includeHidden":false}}
```

Response:

```json
{"id":2,"result":{"data":[],"nextCursor":null}}
```

### config/read and configRequirements/read

`config/read` intentionally exposes only settings with a direct Senpi mapping. The effective config uses the requested
`cwd` to resolve project settings; when `includeLayers` is true, the response includes the user settings file followed by
the project `.senpi/settings.json` layer. Settings without a wire mapping are omitted from both the effective config and
layer payloads.

| Wire key | Senpi source | Unset behavior |
|---|---|---|
| `model` | `SettingsManager` default model id | `null` |
| `model_provider` | `SettingsManager` default provider | `null` |
| `approval_policy` | Senpi permission posture | always `"never"` |
| `sandbox_mode` | Senpi permission posture | always `"danger-full-access"` |
| `model_reasoning_effort` | `SettingsManager` default thinking level | `null` |

The response uses `user` and `project` layer origins only when the corresponding setting is present in that layer; fixed
Senpi posture values have no fabricated settings origin. `configRequirements/read` returns `{"requirements":null}`
because Senpi has no requirements source. Configuration writes are deliberately unsupported; see the `-32601` table.

### remoteControl/status/read

Read Senpi's disabled remote-control status. This method requires `capabilities.experimentalApi: true`.

Request:

```json
{"id":3,"method":"remoteControl/status/read"}
```

Response:

```json
{"id":3,"result":{"status":"disabled","serverName":"senpi app-server","installationId":"00000000-0000-4000-8000-000000000000","environmentId":null}}
```

Without the experimental capability, the same request returns:

```json
{"id":3,"error":{"code":-32600,"message":"remoteControl/status/read requires experimentalApi capability"}}
```

### thread/start

Start a new app-server thread and subscribe the initializing connection to that thread.

Request:

```json
{"id":4,"method":"thread/start","params":{"cwd":"/tmp/senpi-task20-docs/cwd"}}
```

Response:

```json
{"id":4,"result":{"thread":{"id":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","sessionId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"unknown","createdAt":1783017975.555,"updatedAt":1783017975.555,"recencyAt":1783017975.555,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-501Z_019f2427-2ecd-743b-bfec-f7381ee0ccd2.jsonl","cwd":"/tmp/senpi-task20-docs/cwd","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"unknown","modelProvider":"unknown","serviceTier":null,"cwd":"/tmp/senpi-task20-docs/cwd","runtimeWorkspaceRoots":["/tmp/senpi-task20-docs/cwd"],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"activePermissionProfile":null,"reasoningEffort":null,"multiAgentMode":"explicitRequestOnly"}}
```

The server may emit a `thread/started` notification before the correlated response.

### thread/resume

Load an existing saved thread and subscribe the connection to it.

Request:

```json
{"id":5,"method":"thread/resume","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2"}}
```

Response:

```json
{"id":5,"result":{"thread":{"id":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","sessionId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"unknown","createdAt":1783017975.555,"updatedAt":1783017975.555,"recencyAt":1783017975.555,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-501Z_019f2427-2ecd-743b-bfec-f7381ee0ccd2.jsonl","cwd":"/tmp/senpi-task20-docs/cwd","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"unknown","modelProvider":"unknown","serviceTier":null,"cwd":"/tmp/senpi-task20-docs/cwd","runtimeWorkspaceRoots":["/tmp/senpi-task20-docs/cwd"],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"activePermissionProfile":null,"reasoningEffort":null,"multiAgentMode":"explicitRequestOnly","initialTurnsPage":null}}
```

### thread/list

List saved and loaded threads. The response includes `backwardsCursor` for Codex compatibility.

Request:

```json
{"id":6,"method":"thread/list","params":{"limit":1}}
```

Response:

```json
{"id":6,"result":{"data":[{"id":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","sessionId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"unknown","createdAt":1783017975.555,"updatedAt":1783017975.555,"recencyAt":1783017975.555,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-501Z_019f2427-2ecd-743b-bfec-f7381ee0ccd2.jsonl","cwd":"/tmp/senpi-task20-docs/cwd","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]}],"nextCursor":null,"backwardsCursor":null}}
```

### thread/loaded/list

List loaded thread IDs in the current app-server process. The `data` array contains only `string` thread IDs.

Request:

```json
{"id":7,"method":"thread/loaded/list","params":{"limit":1}}
```

Response:

```json
{"id":7,"result":{"data":["019f2427-2ecd-743b-bfec-f7381ee0ccd2"],"nextCursor":null}}
```

### thread/read

Read one thread. Pass `includeTurns: true` to include turn records.

Request:

```json
{"id":8,"method":"thread/read","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","includeTurns":false}}
```

Response:

```json
{"id":8,"result":{"thread":{"id":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","sessionId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","forkedFromId":null,"parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"unknown","createdAt":1783017975.555,"updatedAt":1783017975.555,"recencyAt":1783017975.555,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-501Z_019f2427-2ecd-743b-bfec-f7381ee0ccd2.jsonl","cwd":"/tmp/senpi-task20-docs/cwd","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]}}}
```

### thread/name/set

Set the display name for a thread.

Request:

```json
{"id":9,"method":"thread/name/set","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","name":"Docs example"}}
```

Response:

```json
{"id":9,"result":{}}
```

### thread/fork

Fork a thread into a new session-backed thread.

Request:

```json
{"id":13,"method":"thread/fork","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","cwd":"/tmp/senpi-task20-docs/fork"}}
```

Response:

```json
{"id":13,"result":{"thread":{"id":"019f2427-2f05-7415-818f-5946d46873fe","sessionId":"019f2427-2f05-7415-818f-5946d46873fe","forkedFromId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","parentThreadId":null,"preview":"","ephemeral":false,"modelProvider":"unknown","createdAt":1783017975.583,"updatedAt":1783017975.583,"recencyAt":1783017975.583,"status":{"type":"idle"},"path":"/tmp/senpi-task20-docs/sessions/2026-07-02T18-46-15-557Z_019f2427-2f05-7415-818f-5946d46873fe.jsonl","cwd":"/tmp/senpi-task20-docs/fork","cliVersion":"2026.7.2","source":"appServer","threadSource":null,"agentNickname":null,"agentRole":null,"gitInfo":null,"name":null,"turns":[]},"model":"unknown","modelProvider":"unknown","serviceTier":null,"cwd":"/tmp/senpi-task20-docs/fork","runtimeWorkspaceRoots":["/tmp/senpi-task20-docs/fork"],"instructionSources":[],"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"},"activePermissionProfile":null,"reasoningEffort":null,"multiAgentMode":"explicitRequestOnly"}}
```

### thread/archive

Archive and unload a thread.

Request:

```json
{"id":14,"method":"thread/archive","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2"}}
```

Response:

```json
{"id":14,"result":{}}
```

### thread/delete

Delete a thread.

Request:

```json
{"id":15,"method":"thread/delete","params":{"threadId":"019f2427-2f05-7415-818f-5946d46873fe"}}
```

Response:

```json
{"id":15,"result":{}}
```

### thread/unsubscribe

Unsubscribe the current connection from a loaded thread. The live example below runs after `thread/archive`, so the
thread has already unloaded and the response status is `notLoaded`.

Request:

```json
{"id":16,"method":"thread/unsubscribe","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2"}}
```

Response:

```json
{"id":16,"result":{"status":"notLoaded"}}
```

### turn/start

Start an agent turn on a loaded thread. A successful turn requires a loaded thread and model execution; this live
no-token example documents the current error response for a missing thread.

Request:

```json
{"id":12,"method":"turn/start","params":{"threadId":"missing-thread","input":[{"type":"text","text":"Say ok."}]}}
```

Response:

```json
{"id":12,"error":{"code":-32600,"message":"Thread not found: missing-thread"}}
```

### turn/steer

Queue steering text for an active turn. The live no-token example documents the current error response when the thread
has no active turn.

Request:

```json
{"id":11,"method":"turn/steer","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","expectedTurnId":"not-active","input":[{"type":"text","text":"Prefer brevity."}]}}
```

Response:

```json
{"id":11,"error":{"code":-32600,"message":"No active turn for thread 019f2427-2ecd-743b-bfec-f7381ee0ccd2"}}
```

### turn/interrupt

Interrupt an active turn. Interrupting a non-active or already-finished turn is a successful no-op.

Request:

```json
{"id":10,"method":"turn/interrupt","params":{"threadId":"019f2427-2ecd-743b-bfec-f7381ee0ccd2","turnId":"not-active"}}
```

Response:

```json
{"id":10,"result":{}}
```

### thread/search

Search is experimental and requires `capabilities.experimentalApi: true`. `searchTerm` is case-insensitive; results use
a literal snippet, opaque request-scoped cursors, a default limit of 25 (clamped to 1..100), descending
`created_at` sort, and non-archived threads. Codex's default source filter is interactive (`cli` and `vscode`), so
app-server-created threads require `sourceKinds:["appServer"]` to be included. The isolated example has no matching
interactive thread.

Request:

```json
{"id":17,"method":"thread/search","params":{"searchTerm":"docs"}}
```

Response:

```json
{"id":17,"result":{"data":[],"nextCursor":null,"backwardsCursor":null}}
```

## Supported Request Methods

The following tables are the supported request surface. Entries marked **experimental** require
`capabilities.experimentalApi: true`. Other request validation errors use the method's documented invalid-request or
internal-error path; a listed method is not silently treated as unsupported.

### Stable Methods

| Method | Support and Senpi-specific behavior |
|---|---|
| `initialize` | Required once per connection before all other requests. |
| `model/list` | Configured models only; supports `includeHidden`, numeric cursors, and Codex HEAD model/service-tier fields. |
| `config/read` | Mapped settings subset only: model, provider, reasoning effort, and fixed Senpi permission posture. See [config/read and configRequirements/read](#configread-and-configrequirementsread). |
| `configRequirements/read` | Returns `{requirements:null}` because Senpi has no Codex requirements source. |
| `account/read` | Honest local credential state: `{account:{type:"apiKey"}}` only when a provider credential exists, otherwise `{account:null}`; `requiresOpenaiAuth:false`. |
| `account/rateLimits/read` | Implemented as an honest invalid-request error because rate limits require a Codex account. |
| `account/usage/read` | Implemented as an honest invalid-request error because token usage requires a Codex account. |
| `skills/list` | Resource-loader skills and diagnostics, returned per requested working directory. |
| `mcpServerStatus/list` | Per-loaded-session MCP status; `full` and `toolsAndAuthOnly` detail views with numeric pagination. |
| `permissionProfile/list` | Senpi's actual single `dangerFullAccess`-equivalent profile. |
| `experimentalFeature/list` | Numeric-cursor paginated Senpi feature catalog, currently allowed to be empty. |
| `fuzzyFileSearch` | One-shot subsequence file search over requested roots; an empty query returns no results. |
| `extension_request` | Routes `{threadId,name,data}` to exactly one `pi.rpc.handle(name, handler)` in the loaded thread and returns the handler result. Unknown or duplicate handlers return a typed internal JSON-RPC error. |
| `thread/start` | Creates, loads, and subscribes the calling connection to a session-backed thread. |
| `thread/resume` | Loads a saved thread and subscribes the calling connection. |
| `thread/read` | Reads a thread, optionally including turns. |
| `thread/list` | Lists saved and loaded threads with forward and backward cursors. |
| `thread/loaded/list` | Lists IDs loaded by this app-server process. |
| `thread/fork` | Creates and loads a session-backed fork. |
| `thread/name/set` | Changes the display name and broadcasts `thread/name/updated`. |
| `thread/archive` | Archives and unloads a thread. |
| `thread/unarchive` | Storage-only restore: returns `status:{type:"notLoaded"}` and then broadcasts `thread/unarchived`; it does not resume or attach the thread. |
| `thread/delete` | Deletes a thread and its app-server sidecars. |
| `thread/unsubscribe` | Detaches only the calling connection; a now-idle thread may unload later. |
| `thread/compact/start` | Acknowledges immediately and compacts the loaded thread. Context-compaction items carry progress; Senpi intentionally does not emit `thread/compacted`. |
| `thread/goal/set` | Persists a goal and broadcasts `thread/goal/updated` after the response. Accepts `active`, `paused`, and `complete`; `blocked`, `usageLimited`, and `budgetLimited` are rejected. `tokenBudget` follows omit/keep, `null`/clear, number/set semantics. |
| `thread/goal/get` | Reads the persisted thread goal or `null`. |
| `thread/goal/clear` | Clears a goal and broadcasts `thread/goal/cleared` only when a goal existed. |
| `thread/metadata/update` | Persists `gitInfo` in an app-server sidecar and returns the updated wire thread. |
| `turn/start` | Starts a turn on a loaded thread. |
| `turn/steer` | Queues input for an active turn. |
| `turn/interrupt` | Interrupts an active turn; an already-finished turn is a successful no-op. |

### Experimental Methods

| Method | Support and Senpi-specific behavior |
|---|---|
| `remoteControl/status/read` | Returns the truthful disabled status, server name, stable local installation ID, and `environmentId:null`. |
| `remoteControl/client/list` | Validates Codex-shaped parameters, then returns an honest internal error because this app-server has no remote-control handle. |
| `collaborationMode/list` | Returns Senpi's one fixed collaboration preset. Its `reasoning_effort` member is intentionally snake_case, matching Codex. |
| `thread/search` | Searches session text with source, archive, sort, and cursor filters. The default source filter excludes `appServer`; pass `sourceKinds:["appServer"]` for app-server threads. |
| `thread/searchOccurrences` | Finds literal, case-insensitive UTF-16 ranges in a thread's visible user/final-agent messages; default limit 50, clamped to 1..250. |
| `thread/turns/list` | Paginated turn history with `summary`, `full`, and `notLoaded` item views. Turn logs stay for the process lifetime, including idle unload/resume. After a process restart, reconstruction is intentionally lossy and contains user-message-only turns. |
| `thread/items/list` | Paginated items, optionally limited to a turn. It has the same post-restart history limitation as `thread/turns/list`. |
| `thread/settings/update` | **Partial:** supports only session-scoped `model` and `effort`. Unsupported setting fields fail with an invalid-request error; a successful change sends `thread/settings/updated` only to thread subscribers after the response. |
| `fuzzyFileSearch/sessionStart` | Starts a session over requested roots. |
| `fuzzyFileSearch/sessionUpdate` | Updates a session query and emits `fuzzyFileSearch/sessionUpdated` followed by `fuzzyFileSearch/sessionCompleted`. |
| `fuzzyFileSearch/sessionStop` | Stops an existing fuzzy-search session. |

`fuzzyFileSearch/sessionUpdated` and `fuzzyFileSearch/sessionCompleted` are intentionally not experimental-gated
notifications, matching the Codex request/notification split.

## Notifications And Routing

Responses correlate to requests by `id`. Notifications have `method`, optional `params`, and a required `emittedAtMs`;
they have no `id` and may arrive before, between, or after correlated responses unless noted below.

- Broadcast notifications include thread lifecycle updates, `thread/unarchived`, name changes, global goal updates, and
  fuzzy-search session updates.
- Thread-scoped notifications go only to subscribers of that thread. This includes turn lifecycle and item events,
  `thread/settings/updated`, `turn/diff/updated`, and extension-owned `extension_event` notifications.
- Extensions opt into app-server delivery with `pi.rpc.emit(name, data)`. The notification shape is
  `{method:"extension_event",params:{type:"extension_event",threadId,name,data},emittedAtMs}`. App-server initialize
  capabilities do not include RPC mode's `extension_events` capability, so initialized thread subscribers receive these
  records unconditionally. Ordinary `pi.events` channels remain extension-local and are never forwarded.
- `turn/diff/updated` is Senpi's cumulative aggregation of the projected file-change unified diffs for a turn, in item
  order. It is intentionally not a byte-for-byte substitute for Codex's git-based diff text.
- `thread/unarchive`, goal mutation, and a successful settings mutation send their response before the corresponding
  notification. `thread/compact/start` responds before compaction begins.
- `thread/compacted` is declared in the upstream protocol but is not emitted by Codex HEAD; Senpi does not emit it.
- Terminal `turn/completed` and `error` notifications are queued briefly when no subscriber is attached, then replayed
  to the next subscriber. The per-thread terminal queue is capped at 100 notifications.
- Experimental notifications, including `thread/settings/updated`, are delivered only to connections that enabled
  `experimentalApi`. Clients can opt out of specific notification method names during `initialize`.

## Approvals Flow

When a running turn needs user approval, the server sends a request-like outbound message to subscribers of the affected
thread. Approval request methods include `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval`.

Command approval decisions are `accept`, `acceptForSession`, `decline`, and `cancel`. `acceptForSession` is remembered
for matching command approvals in the same thread. If no subscriber is attached, the approval is declined with a
no-subscriber reason. When a turn ends, pending approvals for that thread are cancelled and `serverRequest/resolved` is
emitted.

### User Input Requests

When the question tool runs, the server sends `item/tool/requestUserInput` to subscribers of the thread. Fields include
`threadId`, `turnId`, `itemId`, `questions` (each with `id`, `header`, `question`, `options`, `multiSelect`),
`waitForAnswer`, and `timeoutMs`. `autoResolutionMs` is always `null` (deprecated). Additive fields `multiSelect`,
`waitForAnswer`, and `timeoutMs` extend the generated `ToolRequestUserInputParams` shape.

Respond with `item/tool/requestUserInput/answered` carrying `answers` (a map of question id to `{ answers: string[] }`)
and an optional `comment`. The first responder wins; later responses are rejected.

Draft updates are sent as `item/tool/userInputProgress` client notifications. Each progress frame resets the idle timer.
The server emits `serverRequest/resolved` when the question resolves (answered, timed_out, cancelled, or
comment-submitted). Pending requests are replayed to new subscribers and cancelled on `agent_end`.

## Multi-Session Semantics

Each app-server process can keep multiple loaded threads. `thread/start`, `thread/resume`, and `thread/fork` load a
thread and subscribe the current connection. `thread/unsubscribe` detaches only that connection; the thread may unload
after the idle timeout when it has no subscribers and no active turn. A websocket listener can serve multiple initialized
clients concurrently. Stdio mode serves one process-owned connection.

The app-server `TurnLog` is retained for the lifetime of the process. Idle unload disposes the session but does not
release its turn log, so unloading and then resuming a thread in the same process preserves full
`thread/turns/list` and `thread/items/list` history. A process restart loses that in-memory log and falls back to the
user-message-only reconstruction documented in the supported-method table.

## Intentional `-32601` Surface

The methods below intentionally return `-32601 Method not found` after initialization. This is an explicit compatibility
boundary: Senpi does not claim to support an API without a local primitive. `thread/turns/items/list` is retired in
Codex HEAD and is also intentionally `-32601`.

| Area | Intentionally unsupported methods |
|---|---|
| Codex account and app flows | `account/login/cancel`, `account/login/start`, `account/logout`, `account/rateLimitResetCredit/consume`, `account/sendAddCreditsNudgeEmail`, `account/workspaceMessages/read`, `app/installed`, `app/list`, `app/read`, `getAuthStatus`, `getConversationSummary` |
| Configuration writes and extension management | `config/batchWrite`, `config/mcpServer/reload`, `config/value/write`, `experimentalFeature/enablement/set`, `hooks/list`, `plugin/install`, `plugin/installed`, `plugin/list`, `plugin/read`, `plugin/share/checkout`, `plugin/share/delete`, `plugin/share/list`, `plugin/share/save`, `plugin/share/updateTargets`, `plugin/skill/read`, `plugin/uninstall`, `skills/config/write`, `skills/extraRoots/set` |
| Direct filesystem and command APIs | `command/exec`, `command/exec/resize`, `command/exec/terminate`, `command/exec/write`, `fs/copy`, `fs/createDirectory`, `fs/getMetadata`, `fs/readDirectory`, `fs/readFile`, `fs/remove`, `fs/unwatch`, `fs/watch`, `fs/writeFile`, `gitDiffToRemote` |
| MCP, marketplace, and external-agent operations | `marketplace/add`, `marketplace/remove`, `marketplace/upgrade`, `mcpServer/oauth/login`, `mcpServer/resource/read`, `mcpServer/tool/call`, `modelProvider/capabilities/read`, `externalAgentConfig/detect`, `externalAgentConfig/import`, `externalAgentConfig/import/readHistories`, `feedback/upload`, `review/start` |
| Thread operations without a backing primitive | `thread/approveGuardianDeniedAction`, `thread/inject_items`, `thread/rollback`, `thread/shellCommand`, `thread/turns/items/list` |
| Windows-only operations | `windowsSandbox/readiness`, `windowsSandbox/setupStart` |
| Environments, processes, memory, and realtime | `environment/add`, `environment/info`, `environment/status`, `memory/reset`, `mock/experimentalMethod`, `process/kill`, `process/resizePty`, `process/spawn`, `process/writeStdin`, `thread/backgroundTerminals/clean`, `thread/backgroundTerminals/list`, `thread/backgroundTerminals/terminate`, `thread/decrement_elicitation`, `thread/increment_elicitation`, `thread/memoryMode/set`, `thread/realtime/appendAudio`, `thread/realtime/appendSpeech`, `thread/realtime/appendText`, `thread/realtime/listVoices`, `thread/realtime/start`, `thread/realtime/stop` |
| Remote-control enrollment | `remoteControl/client/revoke`, `remoteControl/disable`, `remoteControl/enable`, `remoteControl/pairing/start`, `remoteControl/pairing/status` |

The Codex-query skill's documented direct-call APIs are deliberately in this list: `config/value/write`, `plugin/list`,
`fs/readFile`, `fs/readDirectory`, and `command/exec`. A clean `-32601` is the supported outcome for those direct calls;
it is not a transient integration failure.

## Differential Parity Harness

The differential harness runs the Codex source app-server and Senpi side by side in an isolated, zero-credential cell
against the same local fake model. It uses raw websocket frames, normalizes only machine-specific values such as IDs,
timestamps, paths, and tokens, and preserves frame order, array order, and notification audience.

From `packages/coding-agent`, build the pinned Codex oracle once, then run the available handshake scenario:

```bash
bun scripts/qa-app-server/differential/build-oracle.mjs
bun scripts/qa-app-server/differential/run.mjs --scenario handshake
```

The build uses `/Users/yeongyu/local-workspaces/codex/codex-rs/Cargo.toml` and writes the binary under that checkout's
`target/debug/`. The run uses only ports 18990 (fake model), 18991 (Codex), and 18992 (Senpi), creates a temporary cell,
and checks that all three listeners are gone during cleanup. Do not run it in parallel with other app-server QA that
uses the 18990-18999 range.

`packages/coding-agent/scripts/qa-app-server/differential/allowlist.json` is a narrowly scoped gap ledger, not a way to
hide parity failures. Every rule must identify one scenario and normalized frame path, have a non-empty rationale, and
classify the difference as `known-gap` or `allowlisted-delta` (or the explicit harness/regression classifications).
Unclassified differences fail the run. Audience, frame-order, array-order, sequence, and invalid-record differences are
never allowlistable. A rule that no longer matches is a harness defect and fails the run, so resolved gaps must be
removed instead of retained indefinitely.

---

# App Server Daemon

App Server daemon commands start, attach to, inspect, and stop a background app-server listener for Codex-compatible app and editor integrations.

## Starting The Daemon

```bash
senpi app-server daemon start
```

The daemon default listener is `ws://127.0.0.1:18800`. It uses the same bearer-token websocket authentication as app-server mode; the token file is `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}/app-server/ws-token`.

Use `--listen` to choose another supported app-server transport:

```bash
senpi app-server daemon start --listen ws://127.0.0.1:18800
senpi app-server daemon start --listen unix://
senpi app-server daemon start --listen unix:///tmp/senpi-app-server.sock
```

## Subcommands

Every daemon command prints exactly one JSON object to stdout.

### start

`start` first probes the requested listener. If a compatible app-server already answers `initialize`, the command attaches to it instead of spawning another process.

Started a managed daemon:

```json
{"status":"started","pid":12345,"listen":"ws://127.0.0.1:18800"}
```

Attached to a managed daemon that is already running:

```json
{"status":"already-running","pid":12345,"listen":"ws://127.0.0.1:18800","version":"senpi_app_server"}
```

Attached to a compatible listener without a matching managed pidfile:

```json
{"status":"already-running","listen":"ws://127.0.0.1:18800","version":"senpi_app_server"}
```

### status

Managed daemon is running:

```json
{"status":"running","pid":12345,"listen":"ws://127.0.0.1:18800","version":"senpi_app_server"}
```

Compatible listener exists, but it is not tracked by the daemon pidfile:

```json
{"status":"running-unmanaged","listen":"ws://127.0.0.1:18800","version":"senpi_app_server"}
```

No compatible listener is running:

```json
{"status":"not-running"}
```

### stop

Stopped a managed daemon:

```json
{"status":"stopped"}
```

Nothing was running:

```json
{"status":"not-running"}
```

### restart

`restart` stops the managed daemon, then starts it again. It preserves the previous daemon flags from `settings.json` when available, so a daemon started with `--listen unix:///tmp/senpi-app-server.sock` restarts with the same listener even if the restart command omits `--listen`.

```bash
senpi app-server daemon restart
```

The final stdout object is the `start` result, usually `{"status":"started",...}`.

## State Directory

Daemon state lives under `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}`:

```text
app-server-daemon/
  app-server.pid
  daemon.lock
  settings.json
app-server/
  ws-token
  app-server.sock
```

`app-server.pid` stores the daemon pid and process start time to avoid PID reuse. `daemon.lock` serializes daemon commands. `settings.json` stores the launch intent used by `restart`. `app-server.sock` is the default websocket-over-UDS socket path for `unix://`; an explicit `unix:///absolute/path` uses that absolute socket path instead.

## Spawn Or Attach

`start` is idempotent:

1. Probe the requested listener with a real `initialize` request.
2. If the listener answers, print `already-running`.
3. For `ws://` listeners that do not answer, test whether the requested TCP address can be bound. A listener already occupying the address fails immediately with an `EADDRINUSE` diagnostic instead of spawning a child process.
4. If a matching pidfile exists, wait briefly for that process to answer.
5. Otherwise spawn a detached `senpi app-server --listen <url>` process, write the pidfile and settings, then probe until ready.

For websocket listeners, the daemon probe reads the bearer token file and sends `Authorization: Bearer <token>`.

## launchd

For macOS login-session startup, create `~/Library/LaunchAgents/com.senpi.app-server.plist`. Replace `/absolute/path/to/senpi` and `/absolute/path/to/ws-token` with local absolute paths.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.senpi.app-server</string>

  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/senpi</string>
    <string>app-server</string>
    <string>--listen</string>
    <string>ws://127.0.0.1:18800</string>
    <string>--ws-auth</string>
    <string>/absolute/path/to/ws-token</string>
  </array>

  <key>KeepAlive</key>
  <true/>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardErrorPath</key>
  <string>/tmp/senpi-app-server.err.log</string>

  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
```

Load and unload it with:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.senpi.app-server.plist
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.senpi.app-server.plist
```

Check readiness for the websocket form with:

```bash
curl -fsS http://127.0.0.1:18800/readyz
```

## Security

Keep `ws://` listeners on loopback unless the listener is protected by a bearer token and exposed only over a trusted tailnet or equivalent private network. Do not use `--ws-auth off` outside loopback development.

`unix://` uses websocket framing over a Unix-domain socket. The default socket path is same-user local state and should not be shared across accounts. Use the remote-connection pattern from [App Server Mode](app-server.md#starting-app-server-mode): prefer authenticated loopback websocket for app/editor clients, and use UDS only for same-user local control planes.
