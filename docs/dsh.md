# DeepSeek Harness（dsh web）接入调研与实测

> 调研日期：2026-09-29 · 实测版本：**`@deepseek-ai/dsh@0.2.0-rc.2`**（`dsh --version`）· 实测环境：Linux x64 / Node v24.14.1
> 实机探测证据：`.omo/evidence/dsh-adapt/`（启动日志、认证序列、WS mux 探针、完整 session/follow 帧、探测记录）
> 本文所有"实测"结论均来自对本地真实 `dsh web` 进程的 HTTP/WS 探测；标注【源码】的结论来自随包发布的服务端代码（`node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-*/lib/`），未经实机触发。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| dsh 是什么 | DeepSeek 官方 coding-agent 运行时 Harness，npm 包 `@deepseek-ai/dsh`，Cordis 插件架构，profile 制（`web` / `cli` / `acp` / 自定义） |
| dsh web 是什么 | 官方 Web UI（`npx @deepseek-ai/dsh web`），同时是**完整的本地控制平面**：HTTP unary RPC + WebSocket 多路流 + 转发事件流 |
| 能否作为 vis 新后端 | **可以**。协议是标准 JSON 信封 + WS mux，与 kimi web 同构（HTTP REST/JSON-RPC + WS 事件），可完全照 kimi-web 模式经 vis_bridge 转发适配 |
| 最大风险 | ① 仍处 rc 阶段，**协议随版本漂移**（rc.6 → 0.2.0-rc.2 已发生 WS 路径与信封变更，见 §11）；② 真实对话需要 DeepSeek 账号登录或 `DEEPSEEK_API_KEY`（未签名时 turn 以 `MISSING_CREDENTIAL` 失败，失败路径完整可观测） |
| 默认端口 | **3080**（host 默认 `127.0.0.1`）。社区客户端常见 8765 是其自选端口，非默认值 |

---

## 1. 产品线与生态澄清

调研中发现多个同名/近名物，先厘清：

| 名称 | 是什么 | 与本文关系 |
|---|---|---|
| **DeepSeek Harness（dsh）** | DeepSeek 官方 agent 运行时，`@deepseek-ai/dsh` + 约 150 个 `@deepseek-ai/dsh-*` 分包（agent/session/fs/subprocess/tool-*/client-ui-*/api-*-controller 等） | **本文主角** |
| **dsh web** | dsh 的官方浏览器界面（`dsh --profile web`，即 `dsh web`） | 适配目标 |
| dsh-cli / codsh / dsh-code / dsh-TUI | 社区终端 bundle（`dsh --profile cli` 等），复用同一 Harness 服务 | 不涉及 |
| deepseek-harness-web（fufankeji） | 第三方 React 工作台，把 `dsh --profile web` 当子进程管，映射其 HTTP RPC + WS 事件 | 交叉验证来源（基于 **rc.6**，协议已过时，见 §11） |
| codex-dsh-web（OpenNekoPaw） | Codex 插件，经 DSH Web 本地 API 派发任务 | 交叉验证来源（Python 客户端，平铺信封对应旧版） |
| dsh-acp（dushaobindoudou） | 第三方 ACP v1 服务端插件，可挂到 `dsh web` 同端口 `/acp` | 备选接入路径（§13） |
| dsh-web-ui 等插件生态 | `dsh plugin --profile web add <pkg>` 安装的 UI/工具插件 | 不影响核心协议 |

关键事实：**dsh web 的前端自己就是经同一套 `/api` 传输与 Host 通信的**（`@deepseek-ai/dsh-client-connection` 的浏览器半边）。因此这套传输就是官方公开的客户端契约，不是私有接口——但版本未稳定，详见 §11。

---

## 2. 启动与 CLI

### 2.1 命令面

```bash
dsh web                                # = dsh --profile web
dsh --profile web --no-open            # 不起浏览器（服务端适配必须）
dsh --profile web --port 3080          # 指定端口
dsh --profile web --port 0             # 让 OS 分配空闲端口（实测输出行会打印实际端口）
dsh --profile web --host 127.0.0.1     # 绑定主机（默认 127.0.0.1）
dsh --profile web --trusted-host my.lan --trusted-host my.lan:8443   # 额外信任的 /api 权威（可重复）
dsh --profile web --patch ./extra.yml  # 追加 profile 补丁层（重复）
dsh --profile web --dump-config        # 打印组合后的 profile 树后退出
dsh plugin --profile web add <pkg>     # 安装插件
```

启动成功后在 stdout 打印一行（**vis_bridge 应解析此行拿端口与 launch token**）：

```
dsh web: http://127.0.0.1:8765/?token=ZZ_FxX3LiKz3Nccfi6ZShKhCVL6fTQklxQlNNPFJ4PQ
```

### 2.2 flag 语义（【源码】`dsh-web-app/lib/startup.js`）

- `--host <host>`：绑定主机；**`--host 0.0.0.0` 被显式拒绝**（"intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead"）。
- `--port <port>`：非数字报 usage error；`0` = OS 选取。
- `--no-open`：不打开默认浏览器。
- `--trusted-host <authority...>`：`/api` 浏览器信任围栏额外接受的权威（`host` 或 `host:port`，可重复）。无端口条目匹配该主机任意端口；带端口条目精确匹配。条目必须是规范 authority（URL 能改写的一律拒绝为拼写错误）。

### 2.3 默认值（【源码】`dsh-web-app/cordis.patch.yml` webserver 行）

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
    compression: gzip
```

---

## 3. 传输架构总览

dsh web 的控制平面由三条传输组成，全部挂在同一个 node:http 服务器上：

```
浏览器/客户端
  │
  ├─ POST /api/<namespace>/<method>      unary RPC（Connection 承载，application/json 信封）
  │     响应 {ok:true,value} 或 {ok:false,error}；大二进制结果走 multipart/form-data
  │
  ├─ WS   /api/remote.mux                多路逻辑流（Typert Remote stream 的唯一载体）
  │     帧: {type:"open"|"item"|"end"|"cancel"|"error", streamId, ...}
  │     服务端 ping 2s 一次，连续 2 次未响应 terminate
  │
  └─ （$events 是 mux 上的一个逻辑端点，不是独立路径）
        打开后首帧 {type:"ready", clientId, host}，之后推送应用事件
```

要点：

1. **所有 stream 型 Remote 方法（`session/follow`、`session/control`、`workspace/follow`、`job/follow`、`job/list`、`terminal/follow`、`account/watch`、`account/watchExpiry` 等）必须经 `/api/remote.mux` 打开**；经 HTTP 调用会返回 `gateway/signature-invalid`（实测 `job/list`）。
2. **所有 unary 方法必须经 HTTP POST**；在 mux 上打开 unary 方法同样报 `signature-invalid`。
3. mux 上每条逻辑流用客户端分配的 `streamId` 标识；重复 `open` 同一 streamId 是唯一会关闭 socket 的协议违规。

---

## 4. 认证与信任模型

这是适配 vis 时**最容易踩坑**的部分。dsh web 有两道门：**浏览器信任围栏** + **进程 launch token 换 cookie 的会话认证**。

### 4.1 首访认证（【源码】`dsh-client-connection/lib/types/browser-auth.js` + 实测）

- 每个 dsh 进程启动时生成一个 **32 字节随机 launch token**（进程级，WeakMap 绑定 root context），拼在打印的 URL `?token=` 上。
- `GET /?token=<launchToken>`（method=GET、pathname=/、单 token、Host 可解析）→ **303 See Other**，`Location: ./`，并种下 cookie：

  ```
  Set-Cookie: dsh-auth-<base64url(sha256(authority))>=v1.<base64url(payload)>.<base64url(hmac-sha256)>;
              Max-Age=2592000; Path=/; Expires=...; HttpOnly; SameSite=Strict
  ```

  payload = `{"version":1,"authority":"127.0.0.1:8765","issuedAt":<ms>,"expiresAt":<ms>}`。
- cookie 名按 authority（host:port）哈希；签名密钥是 DSH home  credentials 里的持久 secret（`credentialKey("client-connection","browser-session")`，首次启动创建）。**因此 cookie 跨进程重启仍然有效**（只要 authority 相同且未过期，默认 30 天）——对 vis 意味着可以换一次 cookie 长期复用，但 dsh 重装/换 DSH home 会失效。
- 无 token 无 cookie 访问 `/` → **401**（实测）。带 `?token=` 但已持有效 cookie → 303 重定向到干净 URL。

### 4.2 `/api` 围栏（【源码】`dsh-client-connection/lib/types/api-request-trust.js`）

每个 `/api` 请求（含 WS upgrade）都要过：

1. **Host 检查**：Host 必须是 loopback（`localhost`、`[::1]`、`127.0.0.0/8`）或 `--trusted-host` 声明的权威；否则 **403**。
2. **`sec-fetch-site: cross-site`** → 拒绝（403）。
3. **Origin**（若存在）必须与 Host 同源，否则 403。
4. **会话认证**：必须携带有效 cookie，否则 **401**（响应体 `unauthorized`；WS upgrade 拒绝体为 `unauthorized`/`forbidden` 明文 + `Connection: close`）。

对 vis 的含义：

- **非浏览器客户端（vis_bridge 转发）不带 Origin**，过围栏只需 loopback Host + cookie。因此 bridge 必须**先做一次 token→cookie 交换**（`GET /?token=...` 拿 Set-Cookie），之后所有 `/api` 请求带该 cookie。
- bridge 到 dsh 的上行请求**不要带 Origin**（或带与 Host 同源的 Origin）。
- Electron `app://index.html` 等自定义 scheme 无法直接作为浏览器客户端访问（Origin 为 `null` 会被同源检查拒绝），必须经 bridge。

---

## 5. HTTP unary RPC 契约

### 5.1 请求

```
POST /api/<namespace>/<method>
Content-Type: application/json

{
  "type": "client-request",
  "rpcId": "<任意字符串，响应原样回显>",
  "method": "<namespace>/<method>",     // 必须与 URL 路径一致，否则 gateway/bad-request
  "payload": { "args": { ... } }        // 0.2.0-rc.2 起所有端点都必须是 {args:{...}} 包装
}
```

- 非 POST → 404；`content-type` 不是 `application/json` → **415**；body 非 JSON → 400；信封 schema 不符 → `gateway/bad-request` 错误信封。
- 请求体上限 **300 MiB**（413 超出；为 base64 图片聚合上限留的余量）。
- 端点路径段必须匹配 `[A-Za-z0-9_$.-]+`（`..`/空段拒绝）。

### 5.2 响应

```json
{ "type": "server-response", "rpcId": "<回显>",
  "result": { "ok": true, "value": { } } }
```

```json
{ "type": "server-response", "rpcId": "<回显>",
  "result": { "ok": false,
              "error": { "code": "gateway/arguments-invalid",
                         "message": "typert gateway: session/list: args fields do not match the descriptor: missing \"_request\"",
                         "details": { "endpoint": "session/list" } } } }
```

- 错误码是稳定分类（RemoteError 词汇）：`gateway/internal`、`gateway/arguments-invalid`、`gateway/input-invalid`、`gateway/signature-invalid`、`gateway/invocation-unavailable`、`gateway/ambiguous-endpoint`、`gateway/service-unavailable`、`gateway/lookup-not-found`、`gateway/context-not-found`、`gateway/bad-request` 等。
- **`gateway/arguments-invalid` 的错误消息会逐字段告诉你缺什么、多了什么**——适配期最好的调试信息（本文档多个参数结构即由它揭示）。
- 结果中含 `Uint8Array` 字段时，HTTP 响应改为 `multipart/form-data`：`metadata` part 是信封 JSON（`attachments:[{path, codec:"bytes", part}]`），其余 part 是原始字节（【源码】`client-connection/lib/index.js` `fullResponse`）。

### 5.3 端点寻址规则（重要版本差异）

- **0.2.0-rc.2（实测）**：一切端点 payload 必须是 `{args:{...}}`。平铺 payload 直接报 `gateway/internal: Remote payload must contain exactly one plain-object args field`。
- 社区 Python 客户端（codex-dsh-web）用平铺 payload（`{sessionId, mode, content}`）——对应**旧版本**约定；照抄它会连不上 0.2.0-rc.2。**以本文实测信封为准。**

### 5.4 原始字节文件上传（【源码】`dsh-client-file-upload/lib/index.js`）

```
POST /api/session/uploadFileBinary?sessionId=<sessionId>[&name=<文件名>]
Content-Type: application/octet-stream      # 其他 -> 415
<body = 原始字节，streaming 透传，不走 300MiB 缓冲上限>

200 { "ok": true, "value": <receipt> }      # 或 { "ok": false, "error": {...} }
```

- 非 POST → 405；缺 `sessionId` → 400。
- 返回值即 **receiptId**，用于 `session/prompt` 的 content `{type:"file", receiptId}`——附件上传与消息发送因此解耦（先上传拿 receipt，再随 prompt 引用）。
- 该路由独立于 Connection 的 RPC 信封（裸 fetch 路由），但同样过 `/api` 围栏与 cookie 认证。

### 5.5 其他裸 fetch 路由（【源码】+ 实测）

除 RPC 信封路由外，Connection 的 fetch 注册表里还有一批**不走信封**的直连接口，同样过 `/api` 围栏：

| 路由 | 方法 | 查询参数 | 实测行为 |
|---|---|---|---|
| `/api/file` | GET/HEAD | `path=<绝对路径>` | ✅ 200 `application/octet-stream`，经 Host `fs` 服务返回文件原始字节（无 `path` → 400 "missing path"） |
| `/api/session.export` | GET/HEAD | `sessionId=<id>` | ✅ 200 `application/zip`（实测 11866 B，gzip 压缩的会话日志包） |
| `/api/present.host` | GET | 无 | ✅ `{"name":"DESKTOP-3SHDCC0","available":true,"fileManager":"explorer"}`（桌面元数据：主机名、原生打开能力、文件管理器） |
| `/api/present.open` | GET/POST | `sessionId`、`seq`、`index`（+`action=open\|reveal`、`application`） | 400 "Invalid Presented file coordinates."（缺坐标时）；GET 返回可打开应用列表，POST 执行打开（204） |
| `/api/changes.summary` | GET | `sessionId`、`seq` | 参数齐全后 ✅ 路由可达（无变更数据时 404 "Change summary unavailable."） |
| `/api/changes.diff` | GET | `sessionId`、`seq`、`index` | 同上（404 "Change comparison unavailable."） |
| `/api/changes.open` | GET/POST | `sessionId`、`seq`、`index`（+`action`、`application`） | 桌面不可用 → 409 "Host desktop unavailable." |

对 vis 的价值：`/api/file` 可直接做文件读取（与 `workspaceFiles/read` 二选一）；`session.export` 提供会话日志打包下载；`present.host` + `changes.open`/`present.open` 是"在系统应用中打开"能力（桌面端集成可参考，对应 Electron 的 open-in-app 特性）。

---

## 6. WS mux（`/api/remote.mux`）契约

### 6.1 连接

- `ws://<host>:<port>/api/remote.mux`，upgrade 请求过与 `/api` 完全相同的围栏（Host/Origin/cookie；拒绝时以 401/403 明文 HTTP 响应结束 socket）。
- 二进制帧 → `close(1003, "text messages required")`；JSON 解析失败 → `close(1008, "invalid Remote stream request")`。

### 6.2 帧格式（【源码】`dsh-api-gateway/lib/index.js` + 实测）

客户端 → Host：

```json
{ "type": "open",   "streamId": "sf1", "endpoint": "session/follow", "payload": { "args": { "request": { "address": { "kind": "session", "sessionId": "session-..." }, "assistantStream": true } } } }
{ "type": "item",   "streamId": "sf1", "value": <json> }   // 上行（uplink，双向流用）
{ "type": "end",    "streamId": "sf1" }                     // 上行半关闭
{ "type": "cancel", "streamId": "sf1" }                     // 取消
```

Host → 客户端：

```json
{ "type": "item",  "streamId": "sf1", "value": { "type": "snapshot", "header": {...}, "cursor": 17, "records": [...], "hasMore": false, "projections": {...} } }
{ "type": "end",   "streamId": "sf1" }
{ "type": "error", "streamId": "sf1", "error": { "code": "gateway/arguments-invalid", "message": "...", "details": {...} } }
```

- 流结束后迟到帧（item/end/cancel）静默丢弃；重复 `open` 同 streamId → 关闭 socket。
- 上行缓冲上限 256 KiB/流（`streamInboxBytes`），溢出以 `gateway/uplink-overflow` 失败该流。
- **心跳**：服务端每 **2s** 发 ping；客户端连续 **2 次**未回 pong 即 `terminate()`。vis 客户端必须用能自动回 pong 的 WS 实现（`ws` 库默认行为即够）。

---

## 7. 端点全表（11 个 namespace / 72 个端点）

参数结构自【源码】各 controller 的生成描述符（`lib/typert.host.js` zod schema）；标注 ✅ 的为**实机探测通过**，❌ 为实机探测的失败形态，➖ 为未探测（需要前置条件）。

> 本节只列 Typert Remote 端点（走 RPC 信封或 mux）。另有 7 个不走信封的裸 fetch 路由（`/api/file`、`/api/session.export`、`/api/present.*`、`/api/changes.*`）见 §5.5。

> 通用规律：`args` 的字段名**按端点而异**——`session/*` 多为 `args.request.*`；`terminal/list` 是 `args.sessionId`；`terminal/create` 是 `args.agentId` + `args.request`；`workspaceFiles/*` 是 `args.workspaceFileScopeId`（**值是 SessionId，解析出该 session 的 cwd 作为根**）+ `args.path`。错误消息会明确列出缺失/多余字段。

### 7.1 `session` + `skills` + `fileReferences`（21）

| 端点 | 形态 | 参数（`args` 内） | 实测 |
|---|---|---|---|
| `session/list` | unary | `{_request:{}}` | ✅ `{items:[...]}` |
| `session/create` | unary | `{request:{workspaceId?, cwd?, sessionId?, agentPreset?}}` | ✅ `{sessionId, agentPreset}` |
| `session/prompt` | unary | `{request:{requestId, sessionId, mode:"queue"\|"steer", content:[{type:"text",text}\|{type:"image",mediaType,data,name?}\|{type:"file",receiptId}], clientTimeZone?}}` | ✅ `{accepted:true}`（**异步**，结果经 follow 流） |
| `session/cancel` | unary | `{request:{sessionId}}` | ✅ `{accepted:true}` |
| `session/page` | unary | `{request:{address:{kind:"session",sessionId}\|{kind:"subagent",parentSessionId,childSessionId,mode}, throughSeq, beforeSeq?, maxMessages?, turnWindow?}}` | ✅ `{records:[...], hasMore}` |
| `session/follow` | **stream** | `{request:{address, assistantStream?}}` | ✅ snapshot + 增量帧 |
| `session/control` | **stream** | 无参 | ➖（控制帧流） |
| `session/rename` | unary | `{request:{sessionId,title}}` | ✅ `{title, seq}` |
| `session/fork` | unary | `{request:{sessionId, atSeq?}}` | ✅ `{sessionId}` |
| `session/selectModel` | unary | `{request:{sessionId, provider, model, reasoningEffort?}}` | ✅ `{selected:{provider,model,reasoningEffort}}` |
| `session/modelCatalog` | unary | 无参 | ✅ 模型清单见 §10 |
| `session/initializeDefaultModel` | unary | 无参 | ➖ |
| `session/search` | unary | `{request:{query...}}` | ➖ |
| `session/updateQueue` | unary | `{request:{...}}` | ❌ input-invalid（参数结构待补探测） |
| `session/attachment` | unary | `{request:{sessionId, attachmentId}}` | ➖（返回 base64 data + 元数据） |
| `session/canOpenWorkspacePath` | unary | 无参 | ➖ |
| `session/openWorkspacePath` | unary | `{request:{...}}` | ➖ |
| `session/workspacePathApplications` | unary | 无参 | ➖ |
| `session/projections` | unary | `{request:{...}}` | ➖ |
| `session/skills/list` | unary | `{_request:{agentId?}}` | ❌ **404 not found**（agent 作用域服务未激活时端点不存在） |
| `session/fileReferences/list` | unary | `{agentId, query}` | ❌ **404 not found**（同上） |

### 7.2 `workspace` + `directoryPicker`（14）

| 端点 | 形态 | 参数 | 实测 |
|---|---|---|---|
| `workspace/create` | unary | `{request:{path}}` | ✅ `{workspace:{workspaceId,path,title,sessionIds,createdAt,updatedAt}, created:true}` |
| `workspace/follow` | **stream** | 无参 | ✅ `{type:"baseline", value:{items, archivedSessionIds, pinnedSessionIds}}` |
| `workspace/delete` | unary | `{request:{workspaceId}}` | ➖ |
| `workspace/rename` | unary | `{request:{workspaceId,...}}` | ➖ |
| `workspace/insertBefore` / `insertSessionBefore` | unary | `{request:{...}}` | ➖（排序） |
| `workspace/pinSession` / `unpinSession` | unary | `{request:{...}}` | ➖ |
| `workspace/archiveSession` / `unarchiveSession` | unary | `{request:{...}}` | ➖ |
| `workspace/initializeDefault` | unary | 无参 | ❌ `gateway/internal: system Documents directory is unavailable`（无桌面目录环境） |
| `workspace/directoryPicker/list` | unary | `{request:{...}}` | ➖ |
| `workspace/directoryPicker/pick` | unary | `{request:{...}}` | ➖ |
| `workspace/directoryPicker/createDirectory` | unary | `{request:{...}}` | ➖ |

### 7.3 `terminal`（10）

| 端点 | 形态 | 参数 | 实测 |
|---|---|---|---|
| `terminal/list` | unary | `{sessionId}` | ✅ `[]` |
| `terminal/environment` | unary | `{agentId}` | ✅ `{cwd, maxInputBytes:65536, maxCols:500, maxRows:200, scrollback:1000}` |
| `terminal/shells` | unary | `{agentId}` | ✅ `[{path,name,args}]`（zsh/bash 自动探测） |
| `terminal/create` | unary | `{agentId, request:{...}}` | ➖（缺 request 结构，错误消息已提示需 `agentId`+`request`） |
| `terminal/write` | unary | `{request:{...}}` | ➖ |
| `terminal/resize` | unary | `{request:{...}}` | ➖ |
| `terminal/close` / `rename` / `retain` | unary | `{request:{...}}` | ➖ |
| `terminal/follow` | **stream** | `{request:{...}}` | ➖（PTY 输出流） |

### 7.4 `settings`（8）

| 端点 | 形态 | 参数 | 实测 |
|---|---|---|---|
| `settings/describe` | unary | `{}` | ✅ 返回全部 namespace 的 schema/value/base/user/applies/secrets/revision（如 `session-log-deepseek`、`agent-default-model`…） |
| `settings/update` / `mutate` / `replace` | unary | `{request:{...}}` | ➖ |
| `settings/openSettingsDocument` | unary | `{request:{...}}` | ➖ |
| `credentials/describe` / `set` / `unset` | unary | `{request:{...}}` | ➖（**API key 的写入路径**：`credentials/set` ref `DEEPSEEK_API_KEY`） |

### 7.5 `account`（11）

| 端点 | 形态 | 参数 | 实测 |
|---|---|---|---|
| `account/getState` | unary | `{}` | ✅ `{status:"signed-out", attempt:null, links:{usageUrl,topUpUrl}}` |
| `account/getProfile` | unary | `{client}` | ➖（错误消息提示缺 `client`） |
| `account/getBalance` / `getUnnotifiedBonuses` / `hasRunningAccountTasks` / `ackBonusNotified` / `signOut` | unary | `{...}` | ➖ |
| `account/startSignIn` / `cancelSignIn` | unary | `{...}` | ➖（**DeepSeek 账号登录入口**；未实测以免触发真实流程） |
| `account/watch` / `watchExpiry` | **stream** | `{...}` | ➖ |

### 7.6 `job`（3）

| 端点 | 形态 | 参数 | 实测 |
|---|---|---|---|
| `job/list` | **stream** | `{request:{sessionId}}` | ❌ 经 HTTP → `signature-invalid`（必须走 mux） |
| `job/follow` | **stream** | `{request:{...}}` | ➖ |
| `job/kill` | unary | `{request:{...}}` | ➖ |

### 7.7 `workspaceFiles`（5）

| 端点 | 形态 | 参数 | 实测 |
|---|---|---|---|
| `workspaceFiles/list` | unary | `{workspaceFileScopeId(=SessionId), path}` | ✅ `{path, entries:[{name,type,size}], truncated}` |
| `workspaceFiles/stat` | unary | `{workspaceFileScopeId, path}` | ✅ `{absolutePath, version, bytes}` |
| `workspaceFiles/read` | unary | `{workspaceFileScopeId, path, range:{offset?,limit?}}` | ✅ `{absolutePath, version, bytes, offset, text, lines, eof}` |
| `workspaceFiles/readBytes` | unary | `{workspaceFileScopeId, path, options:{baseFile?, range?}}` | ➖ |
| `workspaceFiles/changes` | unary | `{workspaceFileScopeId, ...}` | ➖ |

### 7.8 特殊端点

| 端点 | 说明 |
|---|---|
| `POST /api/$events/result` | 应答 `$events` 流里的 `waterfall` 帧：`payload:{args:{clientId, eventId, outcome}}`，outcome = `{kind:"next"}` / `{kind:"result", value?}` / `{kind:"rejected", error:{name,message,code?,details?}}`（【源码】api-gateway） |

---

## 8. 事件契约

### 8.1 `$events` 逻辑流（mux 上 endpoint=`$events`，payload `{args:{}}`）

打开后：

1. 首帧 **必然**是 `{"type":"ready","clientId":"<uuid>","host":{"home":"<DSH home>"}}`（实测）——证明 Host 事件源就绪；`clientId` 用于应答 waterfall。
2. 之后两类帧：
   - `{"type":"emit","event":"<name>","args":[...]}`——广播事件，只读。
   - `{"type":"waterfall","event":"<name>","eventId":"<uuid>","agentId":"<id>","request":{...}}`——需要客户端处理并**经 `POST /api/$events/result` 应答**（如 `approval/request`、`user-questions/request`）；其他客户端应答前该事件挂起，被取消时收到 `{"type":"cancel","eventId"}`。

**转发事件允许列表**（【源码】`dsh-api-remotes/lib/index.js`，31 个，未列出的事件不会推给浏览器客户端）：

```
agent-preset/selected            api-session/activity          api-session/added
api-session/error                api-session/removed           api-session/status
approval/request                 commands/change               cordis/dynamic-package
cordis/dynamic-retract           cordis/inspect-query          cordis/inspect-query-resolved
cordis/request-run               cordis/request-run-resolved   credentials/record-updated
credentials/reference-updated    deepseek-account/model-sign-in-required
deepseek-account/session-expired goal/activation-changed      llm/adapters-updated
permission-presets/catalog-changed  plugin-manager/changed     plugin-manager/install-log
plugin-manager/install-state     schedule/changed              settings/document-updated
user-questions/request
```

### 8.2 `session/follow` 流帧（实测）

- 首帧 `{"type":"snapshot","header":{version:4,id,createdAt,cwd,isSeeded,agentPreset},"cursor":<seq>,"records":[{"type":"event","event":{type,seq,time,data}}],"hasMore":false,"projections":{asOfSeq,values:{...}}}`
- 之后为增量 `{"type":"item","streamId":"sf1","value":{...}}`（更新帧；断线重连以新 snapshot 的 cursor 续传，`session/page` 可按 `beforeSeq/throughSeq` 补历史）。

**projections.values 字段**（来自 list/snapshot 实测）：`title`、`goal`、`tokenUsage{uncachedInputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`、`contextPressure`、`contextBreakdown{systemTokens,toolsTokens,messageTokens}`、`inbox{next-turn,next-step}`、`sessionStats{turns,steps,llmMs,toolMs,ttftMs,ttftSteps,decodeMs,decodeTokens}`、`turnOutline`、`modelSelection{lastUsed,next}`、`permissions{currentValue}`、`subagentCatalog`、`todos`、`sessionListMetadata{blank,lastPromptAt}`、`imageLimits`、`agentPreset`。

### 8.3 Session 事件词汇表（实测 + 【源码】dsh-acp 桥整理）

| event type | data 摘要 |
|---|---|
| `permission/preset` | `{preset:"workspace-write"}` |
| `sandbox/mode` | `{mode:"workspace-write"}` |
| `approval/policy` | `{policy:"ask"}` |
| `agent/inbox/spliced` | `{target:"next-turn", start, inserted:[{content,source:{kind,rpcId},role,id}]}` / `removedCount` |
| `turn/start` / `turn/end` | `{turn}` / `{turn, reason:{kind:"completed"\|"error"\|"aborted"\|..., error?}}` |
| `step/start` / `step/end` | `{turn, step}` |
| `system/message` / `user/message` | `{turn,step,message:{role,content[]}}`；user 消息带 `source:{kind:"user",rpcId}`（**rpcId 与 prompt 请求的 rpcId 对应，可做应答关联**） |
| `request/header` | `{header:{config:{provider,model,maxTokens,reasoningEffort,adapterDefaults}, tools:[{name,description,parameters}]}}` |
| `request/context` | `{provider, model, contextWindow, systemPromptUpdate}` |
| `session/title` / `session/title-llm-request` | `{title, messageSeqs, source}` |
| `assistant/attempt` | `{turn,step,stream:[{type:"chunk",chunk:{type:"finish",reason:{kind:"error",failure:{message,code}}}}]}` |
| `assistant/message` | `{turn,step,message:{role,content[]}}`（含 text/reasoning block） |
| `tool/call` / `tool/result` | `{turn,step,callId,name,arguments}` / `{turn,step,message:{content[]},error?}` |
| `todo/write` | `{turn,step,todos:[{content,status}]}` |
| `agent/assistant-stream`（进程内事件，0.1.5+ 起不再走 SessionEvent） | `{frame:{type:"start",attemptId,turn,step}}` / `{type:"chunk",chunk:{type:"text-delta"\|"reasoning-delta",text}}` / `{type:"end",attemptId}` |

> 0.1.5 起 `assistant/chunk` SessionEvent 被移除，实时增量改走进程内 `agent/assistant-stream`；`assistant/message` 现在内嵌压缩后的完整流。跨版本消费时必须防重复发射（dsh-acp 0.12.0 的 P0 修复即此）。

---

## 9. 会话生命周期实测（完整证据链）

证据：`.omo/evidence/dsh-adapt/04-session-follow-full.txt`。在**未登录**状态下对真实 session 发送 prompt：

```
session/create {workspaceId}                      → {sessionId:"session-06ee930d-…", agentPreset:"standard"}
POST /api/session/prompt {requestId:"probe-r1", sessionId, mode:"queue", content:[{type:"text",text:"say hi"}]}
                                                 → {accepted:true}          ← 立即返回，异步执行
follow 流 records（seq 3→17）：
  agent/inbox/spliced  {target:"next-turn", inserted:[{content:[{type:"text",text:"say hi"}], source:{kind:"user",rpcId:"probe-r1"}, role:"user", id:"ec747195-…"}]}
  turn/start           {turn:1}
  agent/inbox/spliced  {removedCount:1}                                  ← turn 消费 inbox
  step/start           {turn:1, step:1}
  system/message       {…"You are an AI agent powered by DeepSeek Harness…deepseek-flash…"}
  user/message         {content:[{type:"text",text:"say hi"}], source:{kind:"user",rpcId:"probe-r1"}}
  user/message         {…runtime context snapshot: file policy workspace-write, approval policy ask…}
  user/message         {<system-reminder> available skills …</system-reminder>}
  request/header       {config:{provider:"deepseek-official", model:"deepseek-flash", maxTokens:256000, reasoningEffort:"high", adapterDefaults:{…}}, tools:[…]}
  request/context      {provider:"deepseek-official", model:"deepseek-flash", contextWindow:1000000}
  session/title        {title:"say hi", messageSeqs:[8], source:{kind:"fallback"}}
  session/title-llm-request  {titleProvider:"session-title-first-prompt-llm", route:{…}}
  assistant/attempt    {stream:[{type:"chunk", chunk:{type:"finish", reason:{kind:"error", failure:{message:"llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment", code:"MISSING_CREDENTIAL"}}}}]}
  step/end             {turn:1, step:1}
  turn/end             {turn:1, reason:{kind:"error", error:{message:"…MISSING_CREDENTIAL…", code:"MISSING_CREDENTIAL"}}}
```

**结论**：

1. `session/prompt` 是 fire-and-forget（`{accepted:true}`），**所有结果必须经 `session/follow` 流消费**；turn 结束以 `turn/end` 的 `reason.kind` 为准（`completed`/`error`/…）。
2. 未签名时错误**完整可观测**：`assistant/attempt` 的 finish chunk + `turn/end.reason.error{code:"MISSING_CREDENTIAL"}`。vis 的错误展示可以直接消费这两个字段。
3. **应答关联**：prompt 请求信封的 `rpcId` 会回现在 `user/message` 的 `source.rpcId` 上——与 codex-dsh-web 的相关机制一致，可作为"这条回复对应哪次请求"的锚点。
4. session 级默认值（新建时自动写入 event log）：`permission/preset: workspace-write`、`sandbox/mode: workspace-write`、`approval/policy: ask`。

---

## 10. 可用性矩阵（实机小结）

| 表面 | 状态 | 说明 |
|---|---|---|
| HTTP unary RPC（session/workspace/settings/account/terminal/workspaceFiles） | ✅ 可用 | 见 §7 实测列 |
| WS mux + `$events` + `session/follow` + `workspace/follow` | ✅ 可用 | ready/emit 帧、快照+增量均验证 |
| stream 方法经 HTTP 调用 | ❌ 不支持 | 必须走 mux |
| 平铺 payload | ❌ 不支持（0.2.0-rc.2） | 必须 `{args:{…}}` |
| `session/skills/list`、`session/fileReferences/list` | ❌ 404 | agent 作用域服务未激活（无活跃 agent 时端点不存在） |
| `workspace/initializeDefault` | ❌ internal | 无系统 Documents 目录的环境 |
| 真实 LLM 对话 | ⚠️ 需凭证 | 未登录/无 key 时 turn 以 `MISSING_CREDENTIAL` 失败（路径完整可观测） |
| 模型目录 | ✅ | `session/modelCatalog`：provider `deepseek-official`；`deepseek-flash`(DeepSeek-V41-Flash)、`deepseek-v4-pro`；推理档位 `off/low/high/max`（默认 high） |
| 终端 | ✅ | environment/shells/list 可用；PTY 上限 `maxInputBytes:65536, maxCols:500, maxRows:200, scrollback:1000` |
| 工作区文件 | ✅ | list/stat/read 可用；scope = SessionId → 解析 cwd 为根；`read` 必须带 `range` |
| 裸 fetch 路由 | ✅ | `/api/file`（文件字节）、`/api/session.export`（ZIP 日志，实测 11.8 KB）、`/api/present.host`（桌面元数据）可用；`changes.*`/`present.open` 需 session 坐标参数，路由可达（见 §5.5） |
| 登录 | ➖ 未实测 | `account/getState` 正常；`startSignIn` 未触发（避免真实流程） |

---

## 11. 版本敏感性与稳定性（务必读）

dsh 仍在 rc 阶段，**协议随版本漂移**。本次调研交叉比对出三份客户端约定，互不相同：

| 维度 | rc.6（fufankeji 适配） | 0.1.x 中段（codex-dsh-web Python 客户端） | **0.2.0-rc.2（本文实测）** |
|---|---|---|---|
| 默认端口 | 3080 | 客户端自选 8765（managed 启动 `--port 8765`） | **3080** |
| HTTP 信封 payload | 传统 RPC 平铺；Typert Remote 用 `{args:{…}}` | **全部平铺**（`{sessionId,mode,content}`） | **全部 `{args:{…}}`** |
| WS 路径 | `/api/events.mux` + `/api/events.host`（双通道，帧 `{type:"server-request",rpcId,payload}`） | 无 WS（纯轮询 history） | **单路 `/api/remote.mux`**（帧 `{type,streamId,…}`） |
| 事件获取 | 双 WS 通道帧 | 轮询 `session.history` | `$events` 逻辑流 + `session/follow` |
| 应答关联 | `source.rpcId` | `source.rpcId` | `source.rpcId`（一致） |

其他稳定性事实：

- 版本节奏极快：0.1.0-rc.6（2026-09 早期）→ 0.2.0-rc.2（2026-09-29），约一个月跨过大版本号；生态插件同样紧跟（dsh-acp 32 天内从 0.1.0 追到 0.12.0）。
- **每次升级必须重新探测**：建议把 `.omo/evidence/dsh-adapt/05-probe-log.md` 的探测脚本化，升级后重放，比对端点表与信封。
- `session/*` 的参数名（`request` vs `_request` vs 平铺）在版本间变化过；以当版 `gateway/arguments-invalid` 消息和生成描述符（`node_modules/.../dsh-api-*/lib/typert.host.js`）为准。
- `--host 0.0.0.0` 仍被拒绝：**远程暴露需要 `--trusted-host` + 非 loopback 绑定**，且官方明言这是 RCE 暴露面。vis 的 bridge 转发场景保持 loopback 即可。

---

## 12. 与 vis 现有后端的对照

| 维度 | kimi web | dsh web |
|---|---|---|
| 传输 | REST（`{code,msg,data}` 信封）+ WS 事件 | JSON-RPC 信封 HTTP + WS mux |
| 事件 | WS 单通道事件帧 | `$events`（广播/waterfall）+ 每会话 `session/follow` 流 |
| 应答关联 | 事件 seq/offset 去重 | prompt rpcId → `user/message.source.rpcId` |
| 认证 | 文件 token（Bearer / subprotocol） | launch token → cookie（30 天，跨重启有效） |
| 回放 | WS 重连 + resync + snapshot | 重连 snapshot（cursor）+ `session/page` 补历史 |
| 转发约束 | loopback Origin 白名单 | Host loopback + Origin 同源 + cookie |
| 审批 | REST 应答 | `approval/request`（waterfall 帧）→ `POST /api/$events/result` |
| 模式 | 3 许可模式 + plan/swarm/tower 布尔 | permission preset（`workspace-write` 等，settings/commands 可改）+ agent preset（`standard` 等） |

---

## 13. 备选路径：ACP v1（dsh-acp 插件）

vis 已有成熟 ACP 客户端（`app/backends/acp/` + bridge PTY/stdio 通道）。若不愿直接适配 `/api` 传输，可安装第三方插件 `dsh-acp-server`（`dushaobindoudou/dsh-acp`，npm 包名 **`dsh-acp-server`**，注意与仓库名不同）把 dsh 包成 ACP v1 服务端：

```bash
dsh plugin --profile acp add dsh-acp-server   # 独立 profile：ACP over stdio
dsh web                                        # 或 web-mount：GUI 与 /acp 同端口（默认 3080）
```

要点（【源码】dsh-acp v0.12.0）：

- 传输二选一：`dsh --profile acp`（stdio NDJSON，编辑器场景）或 web-mounted `/acp`（HTTP POST + SSE，`serve` 子命令默认端口 7800）。vis 的 ACP 通道可直接驱动 stdio 形态。
- ACP v1 只覆盖单会话对话；**dsh 专有方法在 `dsh/` 命名空间**：`dsh/sessions/list|read|resume`、`dsh/jobs/list`、`dsh/goals/list`、`dsh/skills/list`、`dsh/agents/tree`、`dsh/sessions/watch|unwatch`，推送通知 `dsh/changed {topics}`。客户端需在 `initialize` 的 `clientCapabilities._meta['dsh/extensions']`  opted-in 才会收到。
- 会话事件经 `session/update` 推送：`agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan`；turn 结束映射 `stopReason`（completed→end_turn、aborted→cancelled、max-tokens→max_tokens…）。
- 审批经 ACP 标准 `session/request_permission`（dsh 侧 `approval/request` 事件；dsh 无授权存储，allow_always 降级为 allowed-once）。

**权衡**：ACP 路径复用 vis 现有 ACP 基建（进程管理、权限 UI、消息规范化），但多一层插件依赖与版本耦合（插件 32 天从 0.1.0 追到 0.12.0，专跟 dsh rc 断裂）；`/api` 直连路径无第三方依赖、能力更全（terminal/workspaceFiles/settings/account），但需要新写传输层。**建议以 `/api` 直连为主路径**（本文档其余章节即按此编写），ACP 作为降级备选记录在此。

---

## 14. vis 适配方案（照 kimi-web 模式）

> 目标架构与 kimi-web 完全同构：**浏览器永不直连 dsh**，REST/WS 一律经 vis_bridge 转发；dsh 进程由 bridge 的 native supervisor 托管。

### 14.1 bridge 侧

1. **进程托管**（`bridge/processSupervisor.js`）：新增 native service 定义，仿 kimi-web：
   - command `dsh`，args `['web','--no-open','--port','<port>']`（端口建议沿用 3080 或自选）；
   - 健康探针：`GET /` 期待 401/303（无 cookie 时 401 即"进程就绪"），或带 cookie 探 `POST /api/account/getState` 期待 `ok:true`；
   - 启动行解析：`dsh web: http://127.0.0.1:<port>/?token=<launchToken>`（同时拿端口与 token）。
2. **凭据交换**（新模块，仿 `bridge/kimiWebToken.js`）：launch token → `GET /?token=` 捕获 `Set-Cookie` → 缓存 `dsh-auth-*` cookie（authority 维度）；dsh 重启后 cookie 仍有效（签名 secret 持久），失效时用新 launch token 重换。
3. **HTTP 转发**（仿 `bridge/kimiWebHttpProxy.js`）：`/dsh/*` → `http://127.0.0.1:<port>/api/*`（注意路径映射：bridge 前缀剥掉后要拼回 `/api/`）；剥掉浏览器带的 `origin`/`host`/hop-by-hop，注入 cookie；**绝不向上游泄露 bridge token**。
4. **WS 转发**（仿 `bridge/kimiWebWsProxy.js`）：`/dsh/ws` → `ws://127.0.0.1:<port>/api/remote.mux`；upgrade 时带 cookie；`connectUpstreamWebSocket` 风格裸握手、不带上行 Origin。
5. **路由注册**（`bridge/visBridgeServer.js`）：HTTP 链加 `/dsh` 分支；upgrade 链加 `/dsh/ws` 分支；`bridge/bridgeConfig.js` 加 native service 默认开；`bridge/visBridgeCli.js` 如需独立端口则加默认值（复用 23004 即可）。

### 14.2 前端侧

1. **契约**（`app/backends/types.ts`）：`BackendKind` 增加 `'dsh'`；新建 `app/backends/dsh/dshAdapter.ts`，能力矩阵参考 kimi（dsh 支持 sessions/fork/archive/pin/terminal/files，**暂不支持 worktrees/todos/questions 视版本而定**）。
2. **客户端**（仿 `app/utils/kimiWeb.ts` + `kimiWebWs*.ts`）：
   - `app/utils/dshRpc.ts`：信封构造/校验（`client-request`/`server-response`）、`{args}` 包装、错误码归类、multipart 结果解析；
   - `app/utils/dshMux.ts`：mux 帧编解码、streamId 管理、ping/pong（依赖 `ws` 自动行为）、断线重连 + snapshot 续传。
3. **适配器**（`app/backends/dsh/`）：`normalize.ts`（follow 记录 → `MessageInfo`/`MessagePart`）、`handlers-*.ts`、`history.ts`（`session/page` 分页）、`bootstrap.ts`（`workspace/follow` → projects、`session/list` → sessions、首个 session follow + history）、`sessionModes.ts`（permission preset 读写）、`backendMessageSend.dsh.ts`（`session/prompt`，mode queue/steer）。
4. **事件桥**（`app/composables/useDshMessageBridge.ts`）：同时挂 `$events`（审批/账号/设置变更）与目标 session 的 `session/follow`；`approval/request` waterfall 帧经 `POST /api/$events/result` 应答（映射到现有 permission UI）。
5. **注册与激活**：`app/backends/registry.ts` 加 `configureDshBackend` + `DEFAULT_DSH_BRIDGE_URL='ws://localhost:23004/dsh/ws'`；`useCredentials` 加 backendKind/URL/token 存储键；`useBackendActivation.activateDsh`；`App.vue` 登录按钮/字段/watchEffect/bootstrap。
6. **构造器绑定纪律**：照 `codexAdapter.ts` `bindBackendMethods()`（:1460）或 kimiWebAdapter 构造器逐方法 `bind(this)`——调用方会把方法当回调传出。
7. **类型契约**：JSON-RPC 响应用**实机探测的真实形状**定义 TS 类型（本项目 memory #798 的教训），mock fixture 必须来自真实 wire 数据（`.omo/evidence/dsh-adapt/`）。

### 14.3 测试与验收（照 kimi-web）

- 单测：信封编解码、normalize、history、mux 帧状态机、registry pin、bridge 边界（`app/dshHttpProxy.boundaries.test.ts` 等）。
- Fixtures：`.omo/evidence/dsh-adapt/04-session-follow-full.txt` 的真实 records → `app/backends/dsh/fixtures/*.jsonl`。
- Live QA：`dsh web` + 真实登录后的端到端（发送 prompt → follow 流渲染 → 审批 waterfall 应答 → 取消/steer）。
- 最终门（按 memory #1090/#1763 惯例）：pnpm lint + Vitest 全量 + Vite build + SEA 重建。

---

## 15. 未验证项与后续探测计划

| 项 | 状态 | 下一步 |
|---|---|---|
| DeepSeek 账号登录全流程（`account/startSignIn` → 事件 → 对话） | 未实测 | 用户提供账号/环境后实机走一遍；或设 `DEEPSEEK_API_KEY` 走 `credentials/set` |
| `credentials/set` 写入 API key 后重放 prompt | 未实测 | 同上；预期 turn 正常完成，可验证 assistant/message 全文 |
| `terminal/create` + `terminal/follow`（PTY 全链路） | 部分 | 补 `request` 结构探测（`terminal/create` 错误消息已提示 `agentId`+`request`） |
| `session/control` 流语义 | 未探测 | mux 打开后观察帧类型 |
| `session/updateQueue` 参数 | 失败待补 | 读 `typert.host.js` schema 后重放 |
| waterfall 事件（`approval/request`、`user-questions/request`）应答闭环 | 未实测 | 需要一个会触发审批的 turn（登录后让模型执行 bash） |
| 多客户端 / 多 observe 同时 follow 同一 session | 未实测 | 双开 mux 验证事件广播 |
| cookie 跨重启有效性 | 源码推断 | 重启 dsh 后用旧 cookie 打 `/api/account/getState` 验证 |
| 大结果 multipart 响应 | 源码推断 | 读一个二进制文件（`workspaceFiles/readBytes`）验证 |
| SSE 传输 | 实机不存在 | 0.2.0-rc.2 的 `cordis.patch.yml` 注释仍写 "browser half is the fetch/SSE client"，但实测服务端只注册 `/api/remote.mux` 一条 upgrade 路由、无 `text/event-stream` 端点；适配只需 HTTP + mux，无需 SSE |

---

## 16. 参考

- 实机探测证据：`.omo/evidence/dsh-adapt/`（`01-startup.log`、`02-auth-sequence.txt`、`03-ws-mux-probe.mjs`、`04-session-follow-full.txt`、`05-probe-log.md`）
- 随包源码（权威）：`node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
  - `dsh-web-app/lib/startup.js`（CLI flags）、`dsh-web-app/cordis.patch.yml`（默认端口/host）
  - `dsh-client-connection/lib/index.js`（HTTP 信封、认证、围栏）、`dsh-api-gateway/lib/index.js`（mux 协议、$events）
  - `dsh-api-{session,workspace,settings,terminal,job,account,workspace-files}-controller/lib/typert.host.js`（端点参数 schema）
  - `dsh-api-remotes/lib/index.js`（转发事件允许列表）
- 上游仓库：`github.com/deepseek-ai/deepseek-harness`（`packages/bundle/web-app`、`packages/api/*-controller`）
- 第三方交叉参考：`fufankeji/deepseek-harness-web`（rc.6 客户端）、`OpenNekoPaw/codex-dsh-web`（旧信封客户端）、`dushaobindoudou/dsh-acp`（ACP 插件与 dsh 内部服务考古）
- 本项目既有文档：`docs/kimi.md`（最接近的适配范式）、`docs/omo.md`、`docs/testing.md`
