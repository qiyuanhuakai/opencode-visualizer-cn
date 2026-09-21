# Kimi Web Server（`kimi web`）

## VIS 适配调研与实测（2026-09-15，Kimi Code 0.43.0）

本节以本机 **Kimi Code 0.43.0** 的真实服务为准：启动 `kimi web --no-open --debug-endpoints`，拉取现场 `/openapi.json`（OpenAPI 3.0.3，`Kimi Code Server API 0.43.0`）与 `/asyncapi.json`（AsyncAPI 3.1.0，`Kimi Code WebSocket API 0.43.0`），并完成 REST + WebSocket 全链路冒烟（建会话 → 订阅 → 发 prompt → 收流式事件 → 读回消息）。与 [docs/codex.md](./codex.md) 相同：文档描述存在不代表当前版本实际支持，能力一律以现场 spec 与实测响应为准。

### 产品线澄清（重要）

存在两个都有 `kimi web` 命令的 Moonshot AI 产品，**不是同一套代码**：

| | **MoonshotAI/kimi-code**（本文档对象） | MoonshotAI/kimi-cli（旧 Python 版） |
| --- | --- | --- |
| 实现 | TypeScript，**Fastify 5** + `ws` + zod | Python，**FastAPI** |
| 默认端口 | **58627** | 5494 |
| API 前缀 | `/api/v1`、`/api/v2`，WS `/api/v1/ws` | 另一套路由 |
| 认证 | `~/.kimi-code/server.token` + `kimi web rotate-token` | `--auth-token` |
| 包 | npm `@moonshot-ai/kimi-code`（本机 0.43.0） | PyPI `kimi-cli`（维护收缩中） |

早期记录中"kimi web 是 FastAPI"的描述对应旧 Python 版；本机 0.43.0 是 TypeScript/Fastify 实现。适配只针对 kimi-code。

### 启动与 CLI

```bash
kimi web [--port 58627] [--host [host]] [--allowed-host <host...>]
         [--dangerous-bypass-auth] [--debug-endpoints] [--no-open]
         [--log-level info] [--rc] [--web-title <title>]
kimi web rotate-token    # 轮换持久 token，旧 token 立即失效
```

- 默认绑定 `127.0.0.1:58627`；端口占用时自动 +1 重试（上限 100 次）。`--host` 无值绑定 `0.0.0.0`。
- 非环回绑定默认要求 TLS 终止代理（`--insecure-no-tls` 可放宽）；非环回时 `POST /api/v1/shutdown` 默认 404，需 `--allow-remote-shutdown`。
- Host 头做 DNS-rebinding 校验，`--allowed-host` 追加白名单（前导 `.` 匹配域名后缀）。
- 启动横幅打印 `http://127.0.0.1:58627/#token=<token>`；fragment 中的 token 只给捆绑 Web UI 自用，不作为接口认证方式。
- `GET /api/v1/healthz`（免认证）实测响应为 `{"code":0,"msg":"success","data":{"ok":true},"request_id":"01M3129HA60G8N5AGSN1CA78FM"}`：业务字段在 `data.ok`，就绪判定必须看它而不是 HTTP 状态码（进程托管据此写探测条件，见 `.omo/evidence/kimi-web-adapt/task-5.txt`）。
- 每个实例注册在 `~/.kimi-code/server/instances/`；与 CLI 共享 `~/.kimi-code` 主目录（config.toml、sessions、credentials）。
- 同一端口同时服务 REST、WebSocket 与捆绑的 Web UI 静态资源。

### 认证模型

- 持久 token 存放在 **`~/.kimi-code/server.token`**（0600），首次启动生成（32 字节 base64url），跨重启复用；`rotate-token` 原子替换并立即使旧 token 失效。服务端按文件 mtime/inode 变化重读 token，轮换无需重启；比较使用常数时间比较。
- **轮换对已建立连接的影响（2026-09-21 实测，`.omo/evidence/kimi-web-adapt/task-23/06-fault-injection/rotate-token.txt`）**：已用旧 bearer 建立的 WebSocket **不会被关闭**，应用层 ping 在轮换后继续流动（25 秒观察窗内 115 次 ping，`lastPingAge` 1798 ms）；旧 bearer 直连上游 REST 返回 401；经 vis_bridge 转发的 REST 与**新拨号**的 WS 都拿到新 bearer（新拨号 101），且**不需要重启 bridge**——token 由 bridge 按请求惰性读取并注入上游，浏览器侧始终只见 bridge 自己的凭据。
- **REST**：`Authorization: Bearer <token>`。
- **WebSocket**：`Authorization` 头 **或** 子协议 `kimi-code.bearer.<token>`。**实测 `?token=` 查询参数不被接受**（连接直接 1006），浏览器侧必须用子协议方式。
- `--dangerous-bypass-auth` 关闭所有 REST/WS 认证，并通过 `/api/v1/meta` 的 `dangerous_bypass_auth: true` 告知 Web UI 免 token 连接。仅限可信网络。
- 免认证路径：`GET /api/v1/healthz`、OPTIONS、非 API 静态资源。认证失败有速率限制（非环回更严）。

### REST 通用约定

- 除二进制/流式外，所有 JSON 响应信封统一为：

```json
{ "code": 0, "msg": "success", "data": { }, "request_id": "01M2HGNZBCD49XZV4TEJ721F67" }
```

- **业务结果看 `code`，HTTP 状态几乎总是 200**。例外：401/429（认证）、201（创建）、204（删除）、206/304（二进制）。
- 错误码段位：`400xx` 参数、`401xx` 认证/就绪（`40101` unauthorized）、`404xx` 不存在、`409xx` 冲突、`410xx` 过期、`413xx` 大小/边界、`429xx` 限流、`5xxxx` 内部、`6/7/8xxxx` 工具/LLM/MCP 透传。
- **REST 线格式为 snake_case**（`session_id`、`created_at`、`pending_interaction`）。
- 现场 spec：`GET /openapi.json`、`GET /asyncapi.json`（`/api/v1/meta` 之外最权威的能力来源）。

### REST 路由概览（0.43.0 实测枚举）

| 分组 | 路由 |
| --- | --- |
| 服务器 | `GET /api/v1/healthz`（免认证）、`GET /api/v1/meta`、`POST /api/v1/shutdown` |
| 认证/OAuth | `GET /api/v1/auth`；`/api/v1/oauth/{login,logout,usage,userinfo,region}` |
| 配置/模型 | `GET|POST /api/v1/config`；`GET /api/v1/models`、`POST /api/v1/models/{id}:set_default`；`GET|POST /api/v1/providers` 及 `:refresh`/`:import_catalog` 等动作；`GET /api/v1/catalog/providers[/{id}]` |
| 会话 | `POST|GET /api/v1/sessions`、`GET /api/v1/sessions/{id}`；`POST …:{fork,compact,undo,abort,btw,archive,restore,delete}`；`GET|POST …/profile`；`POST …/title/generate`；`GET|POST …/children`；`GET …/{status,goal,warnings,snapshot,export}`；`GET|POST …/runtime` |
| 消息/历史 | `GET …/messages`、`…/messages/{message_id}`；`GET …/history`；`GET …/transcript`（需 `agent_id`）、`…/transcript/ops?since_seq=`、`…/transcript/user-messages`、`…/transcript/plan` |
| 提示词 | `GET|POST …/prompts`；`POST …/prompts:steer`；`POST …/prompts/{prompt_id}:{abort,steer}` |
| 审批/提问 | `GET …/approvals?status=pending`、`POST …/approvals/{approval_id}`；`GET …/questions`、`POST …/questions/{question_id}[:dismiss]` |
| 任务/技能/工具 | `GET …/tasks[/{task_id}]`、`POST …/tasks/{id}:{cancel,detach}`；`GET …/skills`、`POST …/skills/{name}:activate`；`GET /api/v1/tools`；`GET /api/v1/mcp/servers`、`POST …/{id}:restart` |
| 能力/插件 | `GET /api/v1/capabilities[/{id}]`、`POST …/{id}:install`；`GET|POST /api/v1/plugins`、`POST …/{id}:{enable,disable,remove}` |
| 终端 | `GET|POST …/terminals`、`POST …/terminals/{id}:close`（仅环回） |
| 工作区 | `GET|POST /api/v1/workspaces`、`PATCH|DELETE …/{id}`；`GET|POST …/trust`、`POST …/untrust`、`POST …/add-dir` |
| 文件系统 | `POST …/fs:{action}`（list/read/stat/mkdir/search/grep/git_status/diff/open 等）；`/api/v1/workspace/fs:{search,suggest}`；`GET /api/v1/fs:{browse,home,content}`；`POST /api/v1/fs:mkdir`；`GET …/fs/{path}:download` |
| 其他 | `POST|GET|DELETE /api/v1/files[/{id}]`（上传）；`/api/v1/gui/store/*`（Web UI 服务端 KV）；`POST /api/v1/search`；`GET /api/v1/connections`；`GET|POST /api/v1/remote-control` |
| v2 | `GET /api/v2/sessions`、`POST /api/v2/sessions:{archive,restore}`；`/api/v2/mcp/*`（auth:begin/complete 等） |
| 调试 | `--debug-endpoints` 时挂载 `/api/v1/debug/*` 与 WS `/api/v1/debug/ws`（生产勿开） |

`/api/v1/meta` 实测关键字段：`server_version`、`server_id`、`backend: "v2"`、`capabilities{websocket,file_upload,fs_query,mcp,tasks,terminal}`、`dangerous_bypass_auth`、`experimental_flags`、`features[]`（skill/plan/goal/todo/usage/cron 等特性开关）。

### WebSocket 协议

端点：**`/api/v1/ws`**（另有源码中存在但未文档化的 `/api/v3/ws` 与调试 `/api/v1/debug/ws`）。

**握手**：连接成功后服务器立即发送 `server_hello`：

```json
{ "type": "server_hello", "timestamp": "…", "payload": {
  "ws_connection_id": "conn_01M2…", "protocol_version": 2,
  "heartbeat_ms": 10000, "max_event_buffer_size": 1000,
  "capabilities": { "event_batching": false, "compression": false } } }
```

**客户端控制帧**（带 `id`，服务端回 `{type:"ack", id, code, msg, payload}`）：`client_hello`（`client_id`、`subscriptions[]`、可选 `cursors`/`agent_filter`）、`subscribe` / `unsubscribe`（`session_ids[]` + 可选 `cursors`）、`subscribe_v2` / `unsubscribe_v2`（单会话 + transcript 级别，见下）、`abort`（`session_id` + `prompt_id`）、`terminal_attach/detach/input/resize/close`、`pong`。

**应用层心跳（实测，必须处理）**：服务器每 10 秒发送 JSON 帧 `{type:"ping", payload:{nonce:"…"}}`；客户端必须回 `{type:"pong", payload:{nonce}}`。**这是应用层 ping/pong，WebSocket 协议层的自动 pong 不算数**；连续约 2 次未回，服务端以 `1001 heartbeat timeout` 关闭连接。

**事件帧信封**（实测样例）：

```json
{ "type": "assistant.delta", "seq": 21, "epoch": "ep_01M2HH1W02…",
  "volatile": true, "offset": 0,
  "session_id": "session_337a…", "timestamp": "2026-09-15T03:18:43.217Z",
  "payload": { "type": "assistant.delta", "time": 1789442323217,
               "agentId": "main", "turnId": 1, "delta": "pong", "sessionId": "session_337a…" } }
```

- 顶层 `type` 即事件名（AsyncAPI 中统称 `session_event`）；**payload 内字段为 camelCase**（`agentId`、`turnId`、`sessionId`），与 REST 的 snake_case 相反，适配层必须在边界转换。
- `seq` + `epoch` 组成会话游标；**durable** 事件可凭 `cursors: {sid: {seq, epoch}}` 在重连 `subscribe`/`client_hello` 时重放。
- **volatile 事件**（`*\.delta` 等流式增量）不重放；同批 delta 共享 `seq`，用 `offset` 排序/去重（实测 9 条 `thinking.delta` 与 1 条 `assistant.delta` 共享 seq 21，offset 递增）。
- 缓冲区溢出（默认 1000 条 durable）或 epoch 变化时收到 `resync_required{session_id, reason, current_seq, epoch}`，随后用 `GET /api/v1/sessions/{id}/snapshot`（含 `as_of_seq`、`epoch` 与完整会话态）重建。
- 系统帧：`server_hello`、`ping`、`resync_required`、`error{code,msg,fatal,request_id?}`。

**事件类型（0.43.0 共 59 种，分组）**：

| 组 | 事件 |
| --- | --- |
| 全局（无需订阅） | `event.session.created/archived/deleted/work_changed/status_changed`、`session.meta.updated`、`event.workspace.created/updated/deleted`、`event.config.changed/warning`、`event.model_catalog.changed`、`event.capability.changed`、`event.plugin.changed`、`event.di.unit_changed` |
| 智能体 | `agent.created/disposed/status.updated`（phase、usage、contextTokens、planMode 等） |
| 回合 | `turn.started/ended`、`turn.step.started/completed/retrying/interrupted` |
| 流式 | `assistant.delta`、`thinking.delta`、`tool.call.delta` |
| 工具 | `tool.call.started`、`tool.progress`、`tool.result`、`tool.list.updated`、`mcp.server.status`、`hook.result` |
| Shell/后台 | `shell.started/output/completed`、`task.started/terminated`、`background.task.started/terminated` |
| 子代理 | `subagent.spawned/started/suspended/completed/failed` |
| 交互 | `event.approval.requested/resolved`、`event.question.requested/answered/dismissed`（在 `pending_interaction` 与 `…/approvals`、`…/questions` REST 有对应快照） |
| 提示词 | `prompt.submitted/started/completed/aborted/steered` |
| 其他 | `compaction.started/blocked/cancelled/completed`、`skill.activated`、`plugin_command.activated`、`goal.updated`、`cron.fired`、`context.spliced`、`error`、`warning` |

错误事件 payload 带稳定 `code`（如 `model.not_configured`、`session.closed`、`context.overflow`、`provider.rate_limit`、`auth.login_required` 等数十种）与 `retryable` 标志。

**Transcript 协议（subscribe_v2）**：`subscribe_v2{session_id, transcript: {agentId: "off|turn|block|delta"}, transcript_since?}` 按代理粒度订阅转录流；服务端推 `transcript.reset` / `transcript.ops`；断线用 `transcript_since` 续传，REST `…/transcript/ops?since_seq=` 兜底（`complete:false` 表示需全量刷新）。

**回放边界契约（2026-09-21 实测，`.omo/evidence/kimi-web-adapt/task-26/REPLAY-BOUNDARY-CONTRACT.md`）**

带 `cursors` 的 `subscribe`/`client_hello` 的补发边界与恢复语义已逐条实测，客户端按以下契约实现：

- **`ack` 是补发→实时的切换点**：补发帧（durable、seq 严格递增）全部先到，**最后**才回 `ack`；不存在 `replay_upto_seq` 之类的独立结束帧。`ack.payload.cursors[sid] = {seq:U, epoch}` 即补发上界 U（6 组实测均等于最后一条补发帧的 seq，也等于 ack 时刻的 `session.last_seq`）。不带 `cursors` 的 `subscribe` 不补发、ack 立即到达；同一 cursor 重复订阅会**重复补发**同一段，durable 必须按 `(session_id, seq)` 去重。
- **volatile 永不补发**：断线期间产生的 delta 只能靠 REST 对账（snapshot / `…/messages`）恢复，WS 不补。同 seq 的 volatile 帧（seq 来自打开该 step 的 durable 事件）**不得**因 `seq <= cursor/U` 被丢弃，那会丢 live 内容。
- **`resync_required` 触发条件**（均已实测）：`cursor.epoch` 与会话 epoch 不匹配、`cursor.seq < last_seq - 1000`（缓冲溢出，边界精确等于 `max_event_buffer_size`）、`cursor.seq > last_seq`（未来游标，reason 被服务端误标为 `epoch_changed`）。触发时 `resync_required{session_id, reason, current_seq, epoch}` 先到、`ack` 仍回 `code:0`——**必须看 `ack.payload.resync_required[]`**，不能只凭 ack 的 code 判断成功。resync 后连接保持订阅，**无需重订阅**；`reason` 不可信，任何 resync 一律按重建处理。
- **snapshot 语义**：`GET /api/v1/sessions/{id}/snapshot` 返回 `{as_of_seq, epoch, session, messages{items,has_more}, in_flight_turn, subagents, pending_approvals, pending_questions}`；`as_of_seq` = 已含的最大 durable seq = `session.last_seq`，是权威重建边界（`epoch` 为**每会话独立**，同一服务端不同会话 epoch 不同）。**快照不携带任何 offset 水位**：同 seq 的 volatile 片段已并入 `in_flight_turn.thinking_text` / `assistant_text`（字符串）。
- **同 seq offset 规则**：恢复点用**内容替换**（快照字符串权威），offset 只作**当前连接内**同一 `(session_id, seq)` run 的排序/去重，禁止跨连接比较（服务端是否跨重连续编号未实测，规则对此保持无关）。
- **完成判据**：`turn.ended.reason` 是唯一完成权威；`prompt.completed` 对失败回合同样会到达，不能当作成功。

### 会话与消息模型

概念层级：**workspace**（`wd_<slug>_<hash12>`，按 cwd 自动创建/复用）→ **session**（`session_<uuid>`）→ **agent**（`main` 主代理 + `subagent.spawned` 产生的子代理，经 `…/children` 查询）→ **turn** → **step**；一次用户输入是 **prompt**（`prompt_id` 与 `user_message_id` 同值，`msg_01…`）。

- `POST /api/v1/sessions`：`{title?, metadata:{cwd}, agent_config?}`；`agent_config` 含 `model`、`system_prompt`、`tools[]`、`mcp_servers[]`、`thinking`、`permission_mode: manual|yolo|auto`、`plan_mode`、`swarm_mode`、`tower_mode`、`goal_objective` 等。
- 会话对象字段：`busy`、`main_turn_active`、`pending_interaction: none|approval|question`、`last_turn_reason: completed|cancelled|failed`、`archived`、`usage{input/output/cache_read/cache_creation/total_cost_usd/context_tokens/…}`、`message_count`、`last_seq`。
- `POST …/prompts`：`content` 为 part 数组（`text` / `tool_use` / `tool_result` / 图片等），同步返回 `{prompt_id, user_message_id, status: running|queued|blocked}`，生成过程全部走 WS 事件；`POST …/prompts:steer` 将排队 prompt 转向注入当前回合。
- `GET …/messages`：**倒序返回**（最新在前），`has_more` 分页；assistant 消息的 `content` part 含 `{type:"thinking", thinking}` 与 `{type:"text", text}`。user 消息带 `metadata.origin.kind`（`user` / `injection`，注入含 system-reminder 类内容，UI 展示需过滤或折叠）。
- 审批应答：`POST …/approvals/{approval_id}` `{decision: approved|rejected|cancelled, scope?, feedback?, selected_label?}`；提问应答走 `…/questions/{question_id}`。
- 中止：WS `abort{session_id, prompt_id}` 或 `POST …/prompts/{prompt_id}:abort` / `POST …:{abort}`。

### 实测坑位（0.43.0，均有线数据佐证）

1. **创建会话时传的 `agent_config.model` 不生效**：`POST /api/v1/sessions` 带 `agent_config.model` 创建后，回合内事件仍显示 `model:""`，prompt 以 `model.not_configured` 失败。必须先 `POST …/profile {agent_config:{model:"kimi-code/k3"}}` 再发 prompt。适配层建会话后应显式写 profile，不要依赖创建参数。
2. **WS 不接受 `?token=` 查询参数**（1006 无说明关闭）；浏览器只能走子协议 `kimi-code.bearer.<token>`。
3. **应用层 ping 必须回 JSON pong**（携带 nonce），否则约 20 秒后 `1001 heartbeat timeout`。
4. **大小写惯例分裂**：REST snake_case、WS payload camelCase（含嵌套 `sessionId`），帧信封本身（`session_id`、`request_id`）又是 snake_case。类型定义须分层建模。
5. `GET …/messages` 倒序 + `has_more` 分页；assistant 内容含 `thinking` part；user 消息可能含 `metadata.origin.kind:"injection"` 的注入消息（实测样例还带 `variant:"date_change"` 等附加字段，权威路径是 `metadata.origin.kind`，不是顶层 `origin.kind`）。
6. volatile delta 不可重放，共享 seq、以 offset 排序；durable 事件才可 cursor 重放。
7. `model.not_configured` 失败路径：turn 以 `turn.step.interrupted(reason:"error")` → `turn.ended(reason:"failed")` → `error` 事件结束，`prompt.completed` 仍会到达——完成不等于成功，须看 `turn.ended.reason` / `last_turn_reason`。

### 与 OpenCode web 的对照

| 维度 | OpenCode（vis 现有后端） | kimi web 0.43.0 |
| --- | --- | --- |
| 传输 | REST + **SSE**（`/global/event`） | REST + **WebSocket**（`/api/v1/ws`，带 ack 的控制帧） |
| 认证 | 无或 Basic | Bearer token（持久文件），WS 用子协议 |
| 事件信封 | `{directory, payload:{type, properties}}` | `{type, seq, epoch, volatile, offset, session_id, timestamp, payload}` |
| 可靠性 | 无游标/重放 | seq+epoch 游标、durable 重放、`resync_required`+snapshot |
| 流式增量 | `message.part.delta` SSE | `assistant.delta`/`thinking.delta`/`tool.call.delta`（volatile，offset 去重） |
| 会话操作 | `/session/{id}` REST | `POST …:{archive,restore,delete,fork,compact,undo,btw}` |
| 审批/提问 | SSE `permission.asked`/`question.*` + REST 应答 | WS `event.approval.*`/`event.question.*` + REST 应答 |
| 健康检查 | `GET /global/health` | `GET /api/v1/healthz`（免认证） |
| 能力发现 | 无统一入口 | `/api/v1/meta` + 现场 `/openapi.json`、`/asyncapi.json` |
| 托管 | vis_bridge 监督 `opencode serve :4096` | 可同样由 vis_bridge 监督 `kimi web` |

### 为什么必须经 bridge 转发（2026-09-15 实测）

**结论：kimi web 后端统一经 vis_bridge 转发，浏览器不直连。** 只有本地环回开发源直连在技术上是通的，但 vis 的生产形态（GitHub Pages 托管、Electron 桌面）都被 kimi web 的 Origin 白名单拒绝，且服务端没有任何配置项可以放开。为了不在三种部署形态间维护两套传输路径，统一走转发。

不能直连的原因，按因果链拆开：

1. **kimi web 对 WS 升级做 Origin 白名单校验，且白名单只含环回源。** 实测 WS 升级握手：`Origin: http://localhost:23003` 与不带 Origin 返回 `101 Switching Protocols`；`Origin: https://qiyuanhuakai.github.io`、`Origin: app://index.html` 及任意陌生源一律 `403 Forbidden`。
2. **浏览器无法绕过这个校验。** WebSocket 握手不受 CORS 约束，但浏览器在 WS 升级时**强制携带**页面源的 `Origin` 头，`WebSocket` API 没有任何方法删除或改写它（能设置的只有子协议——所以认证本身不是问题，`kimi-code.bearer.<token>` 子协议浏览器可用）。Origin 不在白名单 ⇒ 握手 403 ⇒ 页面源的直连必然失败。
3. **REST 同样被 Origin 门控。** 服务端只对环回源反射 `Access-Control-Allow-Origin`；Pages / `app://` 源的响应是 200 但**不带 ACAO 头**，浏览器拦截读取（带 `Authorization` 的预检同样失败）。REST 本身受 CORS 约束，这条路也断了。
4. **没有放开的配置项。** `--allowed-host` 只放宽 Host 头（DNS-rebinding 防护），与 Origin 白名单无关；`--dangerous-bypass-auth` 只关 token 认证，不动 Origin 校验。0.43.0 不存在"允许指定 Origin"的开关。
5. **Electron 的变通是 hack，不采用。** 理论上 main 进程可用 `session.webRequest.onBeforeSendHeaders` 改写 WS 握手的 Origin，但这依赖 Electron 内部行为、与沙箱策略纠缠，不作为产品路径。

转发行得通的原因：vis_bridge 是非浏览器客户端，向上游发起 WS/REST 时**不带 Origin 头**，实测被接受（101）；Origin 白名单只挡浏览器源，不挡服务器间转发。

实测矩阵：

| 调用方源 | REST（`Access-Control-Allow-Origin`） | WS 升级 `/api/v1/ws` |
| --- | --- | --- |
| `http://localhost:23003`（vis 本地 dev/serve） | 反射放行 ✓ | `101 Switching Protocols` ✓ |
| 无 Origin（bridge、curl、Node 等非浏览器） | 不需要 CORS | `101` ✓ |
| `https://qiyuanhuakai.github.io`（Pages 托管） | 200 但无 ACAO 头，浏览器拦截 | `403 Forbidden` |
| `app://index.html`（Electron 桌面） | 200 但无 ACAO 头 | `403 Forbidden` |
| 任意陌生源 | 无 ACAO | `403 Forbidden` |

转发实现要点：vis_bridge 已有 Codex WS 代理与 ACP stdio→WS 转发的现成机制，新增一条 `kimi-web` 代理路由即可——REST 与 WS 上行转发到 `127.0.0.1:58627`，剥离 Origin（或不构造该头），复用 bridge token 认证；kimi 的 bearer token 由 bridge 从 `~/.kimi-code/server.token` 读取后注入上游请求，不下发到浏览器。进程托管（探测/拉起 `kimi web`）与传输转发是两件事，同一 supervisor 条目覆盖。

### VIS 适配方案

结论先行：**传输层统一经 vis_bridge 转发**（原因见上节）；**事件归一化走 ACP 式自定义桥**——kimi web 的事件传输是带控制帧的 WebSocket，不是 SSE，`sse-shared-worker` 管线（硬编码 `/global/event` 与 OpenCode 事件包形状）不可复用。新增独立 WS 客户端（连 bridge 代理路由）+ 消息归一化桥，把 kimi 事件映射进现有 `MessageInfo`/`MessagePart` 与 `serverState`（参照 `useAcpMessageBridge` 的角色），而不是改造 SSE worker。

注意与现有 **kimi-code ACP 预设**（`bridge/bridgeConfig.js`，`kimi acp` stdio 代理）区分：那是第三后端 ACP 通道；kimi web 是 kimi 自家的一等 HTTP/WS 服务，能力更全（transcript 级别订阅、快照重同步、终端、文件历史、任务管理），值得作为独立 `BackendKind` 接入。

**集成点清单**（按改动面分组）：

1. **契约与注册**：`app/backends/types.ts` 增加 `'kimi-web'` 到 `BackendKind` 与能力位；新建 `app/backends/kimiWeb/kimiWebAdapter.ts` 实现 `BackendAdapter`；`app/backends/registry.ts` 注册 + `configureKimiWebBackend`。
2. **客户端**：新建 `app/utils/kimiWeb.ts`（REST 封装，信封 `code` 校验、snake_case 线类型）与 WS 客户端（子协议认证、client_hello/subscribe、应用层 pong 应答、cursor 重连重放、`resync_required`→snapshot 重建）。
3. **凭据与登录**：浏览器侧只见 bridge——登录页复用 Codex/ACP 的「bridge URL + bridge token」字段模式（storage keys 与 `useCredentials` 增 `kimi-web` 分支即可）；kimi 的 bearer token 不下发到页面，由 bridge 从 `~/.kimi-code/server.token` 读取并注入上游请求。`app/App.vue` 登录页增后端按钮；`app/locales/*` 增文案。
4. **激活与围栏**：`app/composables/useBackendActivation.ts` 增 `activateKimiWeb`；所有异步预检/提交继续走 `createBackendRequestFence()`（backend identity + generation 双匹配，见既有约束）。
5. **事件→状态桥**：新建 `useKimiWebMessageBridge`（参照 `app/composables/useAcpMessageBridge.ts`）：durable 事件驱动 `serverState`/会话列表，`assistant.delta`/`thinking.delta` 流式进 `useMessages.updatePart`（经 `useDeltaAccumulator`），`turn.ended`/`prompt.completed` 驱动完成态（**以 `turn.ended.reason` 为准，不用完成事件冒充成功**），`event.approval.*`/`event.question.*` 接现有权限/提问 UI。`app/types/worker-state.ts` 与 `MessageInfo`/`MessagePart` 契约**保持不变**，在桥边界做 camelCase→现有形状的归一化。
6. **会话动作分支**：`useBackendSessionActions.ts`（delete/archive 用 `:delete`/`:archive`/`:restore`，rename 用 `POST …/profile`）、`useBackendSessionLifecycle.ts`（create 后**必须补 profile 写 model**；abort 用 WS abort/REST `:abort`）、`useBackendMessageSend.ts` + 新建 `backendMessageSend.kimiWeb.ts`（content part 构造、附件上传走 `POST /api/v1/files`）、`useBackendSessionReload.ts`（历史用 `GET …/messages` 倒序分页 + `GET …/transcript`，注入消息按 `metadata.origin.kind` 过滤）。
7. **能力门控**：遵循既有规则——UI 暴露前做运行时探测。以 `/api/v1/meta.capabilities` + `/api/v1/auth`（`models_ready`、managed provider 状态）为一级门，具体动作（fork/compact/undo/btw、transcript 级别、终端）以实测响应为准；`experimental_flags` 只做展示不做门。
8. **进程托管**：`bridge/processSupervisor.js` 增服务定义 `{id:'kimi-web', command:'kimi', args:['web','--port','58627','--no-open'], probe:{type:'http', url:'http://127.0.0.1:58627/api/v1/healthz'}}`（healthz 免认证，适配现有 HTTP 探测）；token 由 `~/.kimi-code/server.token` 读取，不经命令行传递。桌面端版本显示/更新检查语义不变，kimi web 不进 bridge 版本通道。
9. **测试**：WS 事件 fixture 必须来自真实线数据（本文档信封样例 + 现场 asyncapi），禁止手写不匹配的形状；REST mock 需覆盖信封非 0 `code` 而 HTTP 200 的路径。冒烟脚本可复用本次调研的建会话→订阅→prompt→读回链路。

### VIS 适配状态（2026-09-21 真机冒烟，Alpha）

本节记录 kimi-web 作为**第四个后端**在 vis 中的实际落地状态。全部结论来自 Todo 23 真机冒烟（真 `kimi web` 0.43.0 + vis_bridge + 前端全链路），证据目录 `.omo/evidence/kimi-web-adapt/task-23/`（索引见其 `README.md`）。本节只列**实测通过**的面；服务端有路由但 vis 未接入的面显式列为「未接入」，不拿协议存在当能力。

**主会话功能面（冒烟逐项通过）**

| 面 | 实测结论 | 证据 |
| --- | --- | --- |
| 登录与连接 | 登录页填 bridge URL + bridge token；预检（bridge `/healthz` + 转发 `/api/v1/meta`）→ 引导 → WS `client_hello` → `subscribe`(+cursors) → ack → 应用层 ping/pong 全链路通 | `04-frontend/01-login-kimiweb-fields.png`、`03-proxy-checks/proxy-checks.txt`、`04-frontend/ws-after-login.json` |
| 建/选会话 | 固定两次调用顺序：`POST /api/v1/sessions` → `POST …/profile` 写 model（坑位 1 的规避手段）；新建会话即时进入 `serverState.projects`，选中不再被弹回旧会话 | `05-checklist/a-create-session-writes.json`、`a-new-session-state.json`、`a-new-session-created.png` |
| 流式 text + thinking | 回合内 `assistant.delta`/`thinking.delta` 实时进消息区；推理悬浮窗在运行中的回合打开、随终结 part 关闭（窗口关闭快，需在回合中抓取）。delta 帧由 F3 独立复跑的线据捕获证明（`b-p1-events.json` 是首次冒烟第 1 个 prompt 的失败路径，不含 delta） | `05-checklist/b-wire-frames-f3.jsonl`、`b-wire-relevant-f3.json`、`c-p2-running.png` |
| 历史 + 注入过滤 | `GET …/messages` 倒序分页拼接（6 页同集合、无重复、顺序保持）；`metadata.origin.kind === "injection"` 由加载器过滤（实测同一会话识别出 2 条注入消息） | `05-checklist/h-multipage-stitching.txt`、`h-smoke-session.har` |
| 审批 | 通过与驳回各一次，`event.approval.resolved` 回填；pending 集合以 `…/approvals?status=pending` 列表为权威，WS 事件只作对账触发（"通过"一次的 POST 线据见 F3 复跑捕获） | `05-checklist/d-approval-pending.png`、`d-rejected.png`、`d-approval-poll-f3.txt`、`../f3/01-live/live-smoke.har` |
| 提问 | 应答与 dismiss 均通（同一回合内连续两个提问，各自应答/dismiss） | `05-checklist/e-question-dialog.png`、`e-question-2.png`、`e-question-2-dismissed.png` |
| steer | `POST …/prompts:steer {prompt_ids}` → `{"steered":true}`，UI 侧生效（WS `turn.steer`/`prompt.steered` 帧未捕获，不作声明） | `05-checklist/f-steer-response.json`、`f-steer-ui.png` |
| 附件 | `POST /api/v1/files` 先于 `POST …/prompts` 发出（HAR 顺序证明），prompt 引用返回的 `file_id`/`name`/`size`（模型当回合读取文件的内容未捕获，不作声明） | `05-checklist/g-attachment-attached.png`、`h-smoke-session.har` |
| 重命名/归档/恢复/删除 | 四项均通；删除后服务端 `40401` | `05-checklist/i-renamed.png`、`i-archived.png`、`i-archive-restore.txt`、`i-restored.png`、`i-deleted.png` |
| 中止 | 双击 Esc → `POST …:abort` 200 → `turn.ended` reason `cancelled`（interruptReason `user_cancelled`），UI 回 Idle | `05-checklist/j-abort-midflight-wire.json`、`j-abort-midflight.png` |
| Token 用量 | 主源为 bridge 会话状态；状态为空时回退 `GET …/status`（经桥）读 `context_tokens`/`max_context_tokens` | `05-checklist/k-token-usage-live.png`、`k-token-usage-live-rest.json` |
| 状态监视器 | server 页显示 Healthy、版本、capabilities（取自 `/api/v1/meta`）与 models ready（取自 `/api/v1/auth`）；MCP、LSP、PLUGINS、SKILLS 页显示 kimi-web 不支持 | `05-checklist/k-server-tab.png` |
| 能力门控 | 一级门 `/api/v1/meta.capabilities` + `/api/v1/auth.models_ready`；探测失败一律 unknown（fail-closed），`experimental_flags` 只展示不做门 | `03-proxy-checks/proxy-checks.txt`、`app/backends/kimiWeb/capabilityRegistry.ts` |
| 三路自动弹窗 | 工具/推理/子代理悬浮窗均自动弹出并正确关闭（DOM 级断言 + 约 1 s 轮询标题；子代理弹窗无专门截图，以 F3 复跑的 DOM 轮询日志为证——第 10/11 次轮询三窗同现），遵循禁止自动弹窗设置 | `05-checklist/c-live-poll-f3.txt`、`c-p2-running.png` |

**传输与托管面（同样实测）**

| 面 | 实测结论 | 证据 |
| --- | --- | --- |
| bridge 转发 | REST 与 WS 全部经 vis_bridge `/kimi-web/*` 转发（浏览器直连会被 Origin 白名单 403，原因见上节）；kimi bearer 由 bridge 惰性注入、不下发浏览器；错误 bridge token 401 | `03-proxy-checks/proxy-checks.txt`、`ws-upgrade.txt` |
| rotate-token | 已建立 WS 不被关闭、ping 继续流动；新拨号 101；REST 经桥无 bridge 重启即恢复 | `06-fault-injection/rotate-token.txt` |
| 断线重连 | 中断后重连链路分两段取证：WS 关闭与退避阶梯见 `port-occupancy.txt`（1006/1005 关闭，关闭时间戳间隔约 0.5/1/2/4 s）；重订阅与重建见 `reconnect-cursors.json`（client_hello 带 cursors + pong + ack 回 `resync_required`，该文件本身不含 1006 与退避帧、捕获串被截断）；重连后历史完好、无错误横幅 | `06-fault-injection/port-occupancy.txt`、`reconnect-cursors.json`、`reconnected.png` |
| supervisor 三态 | 端口被外人占用 → state error 且**不 spawn**，外人监听保持；端口释放后 spawn 自有子进程并实际绑定 58627 | `06-fault-injection/port-occupancy.txt`、`supervisor-error-state.json` |
| Pages 源跨源 | 经桥取 JSON + 二进制（fs 下载，`Content-Type` 保留）+ WS 101 均带 ACAO（直连路径会被 403） | `06-fault-injection/cors-pages-origin.txt` |
| token 文件不可读 | chmod 000 → 502 `KIMI_TOKEN_UNREADABLE`（带 CORS）→ chmod 600 后无重启恢复 | `06-fault-injection/token-file-permissions.txt` |
| 双客户端 | 两个 vis 客户端实例并行操作同一 kimi web（截图证明）；服务端连接数读取（`/api/v1/connections`）未留存，不作声明；会话列表变更不在客户端间传播，需重载 | `06-fault-injection/two-clients-a.png`、`two-clients-b.png` |

**未接入（kimi 独有面，vis 不暴露）**

服务端有这些路由/帧，vis **故意不接**，UI 也不留入口：

- **终端**：`…/terminals` REST 与 `terminal_attach/detach/input/resize/close` WS 帧（仅环回可用）。
- **任务管理**：`…/tasks[/{task_id}]`、`POST …/tasks/{id}:{cancel,detach}` 与 `task.started/terminated`、`background.task.*` 事件。
- **文件历史 / fork / compact / undo / btw**：kimi 服务端会话动作；`KimiWebAdapter` 对 fork/revert 显式返回 unsupported，其余不进 UI。
- **`subscribe_v2` transcript 分级订阅**：协议存在（见「WebSocket 协议」节），vis 只用一级 `subscribe` + cursor 重放。
- **GUI store**：`/api/v1/gui/store/*`（Web UI 服务端 KV）。
- **`/remote-control`** 与 `--debug-endpoints` 调试面（`/api/v1/debug/*`、`/api/v1/debug/ws`）。
- **项目目录选择器 / provider 配置编辑 / worktree**：kimi 侧无对应语义，UI 对这些入口 fail-closed（显式分支见 `07-guard-strict/SUMMARY.md`）。

**已知限制（实测观察，不是缺陷承诺）**

1. **Token 页在新页面上先是「仅上下文」**：`agent.status.updated` 是 volatile、不重放，刷新后 bridge 会话状态为空，于是走 `GET …/status` 回退——该端点只报 `context_tokens`/`max_context_tokens`，没有 token 计数，UI 显示来源说明并**不编造** token 行；本回合跑起来后 bridge 状态重新成为主源。证据：`05-checklist/k-token-usage-live.png`、`k-token-usage-live-rest.json`。
2. **`getSessionStatus()` 在 0.43.0 上没有 `pending_interaction`**：会话级 pending 声明缺失，对账只能以 `…/approvals`、`…/questions` 列表为权威（实现见 `app/backends/kimiWeb/interactions.ts` 的 `declaredPendingInteraction`）。
3. **volatile 帧永不重放**：断线期间产生的 delta 只能靠 snapshot / `…/messages` 对账补齐，契约见「WebSocket 协议」节。
4. **steer 只有线路级路径**：`POST …/prompts:steer` 实测可用，但 kimi-web 输入框没有 steer 按钮。
5. **会话列表元数据不实时**：重命名/归档状态在刷新或重新引导前不传播（双客户端场景同样如此）。

### 参考

- 官方文档：Server 指南 `https://www.kimi.com/code/docs/en/kimi-code-cli/guides/server.html`；API 参考（仓库内 `docs/en/reference/server-api.md`）。
- 源码：`https://github.com/MoonshotAI/kimi-code`，服务端包 `packages/kap-server`（路由注册 `src/routes/registerApiV1Routes.ts`，WS 控制帧 `src/transport/ws/protocol/ws-control.ts`）。
- 现场 spec（任何版本）：`curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58627/openapi.json` 与 `/asyncapi.json`。
- 旧 Python 版（仅辨析用）：`https://github.com/MoonshotAI/kimi-cli`，`src/kimi_cli/web/app.py`（FastAPI，端口 5494）。
