# DeepSeek Harness（dsh web）接入调研与实测

> 调研日期：2026-09-29 · 实测版本：**`@deepseek-ai/dsh@0.2.0-rc.2`**（`dsh --version`）· 实测环境：Linux x64 / Node v24.14.1
> 实机探测证据：`.omo/evidence/dsh-adapt/`（启动日志、认证序列、WS mux 探针、完整 session/follow 帧、探测记录）
> 本文所有"实测"结论均来自对本地真实 `dsh web` 进程的 HTTP/WS 探测；标注【源码】的结论来自随包发布的服务端代码（`node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-*/lib/`），未经实机触发。
> vis 侧适配的落地与实测状态集中在 **§0.1**（以 Todo 36 真机冒烟为准），§15 是逐行裁定过的未验证项清单；两节之外的协议结论仍是探测期原样记录，凡改写处均在正文标注来源。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| dsh 是什么 | DeepSeek 官方 coding-agent 运行时 Harness，npm 包 `@deepseek-ai/dsh`，Cordis 插件架构，profile 制（`web` / `cli` / `acp` / 自定义） |
| dsh web 是什么 | 官方 Web UI（`npx @deepseek-ai/dsh web`），同时是**完整的本地控制平面**：HTTP unary RPC + WebSocket 多路流 + 转发事件流 |
| 能否作为 vis 新后端 | **可以**。协议是标准 JSON 信封 + WS mux，与 kimi web 同构（HTTP REST/JSON-RPC + WS 事件），可完全照 kimi-web 模式经 vis_bridge 转发适配 |
| 最大风险 | ① 仍处 rc 阶段，**协议随版本漂移**（rc.6 → 0.2.0-rc.2 已发生 WS 路径与信封变更，见 §11）；② 真实对话需要 DeepSeek 账号登录或 `DEEPSEEK_API_KEY`（未签名时 turn 以 `MISSING_CREDENTIAL` 失败，失败路径完整可观测） |
| 默认端口 | **3080**（host 默认 `127.0.0.1`）。社区客户端常见 8765 是其自选端口，非默认值 |

### 0.1 适配状态（vis 侧落地情况，以 Todo 36 真机冒烟为准）

事实来源只有两个：`.omo/evidence/dsh-web-adapt/task-36/00-smoke-run.log`（**41/41 断言 PASS，退出码 0**，运行模式 `degraded`）与同目录 `degraded-items.md`（未实测清单，一行一条理由）。本节每一行都能在该目录里指到证据，可逐行对账；未进入清单的表面一律不写成已支持。

落地代码：bridge 侧 `bridge/processSupervisor.js`（dsh 托管）、`bridge/dshAuth.js`（launch token → cookie）、`bridge/dshHttpProxy.js`（`/dsh/*` → `/api/*`）、`bridge/dshWsProxy.js`（`/dsh/ws` → `/api/remote.mux`）、`bridge/bridgeConfig.js`（`nativeServices.dsh`）；前端侧 `app/backends/dsh/`、`app/utils/dshRpc.ts`、`app/utils/dshMux.ts`、`app/composables/useDshMessageBridge.ts`、`app/composables/dshPermissions.ts`。

**版本钉死**：只支持协议代 `0.2.0-rc.2`。版本闸门在 `bridge/processSupervisor.js`（`DSH_SUPPORTED_VERSION`）：不符即停掉该子进程并提示安装。唯一受支持的安装命令（与 `DSH_INSTALL_GUIDANCE` 逐字一致）：

```bash
npm i -g @deepseek-ai/dsh@0.2.0-rc.2
```

| 状态 | 判定标准 | 表面 |
|---|---|---|
| **已接面** | 已落地，且 Todo 36 有 PASS 断言 | 见下方已接面清单 |
| **已接面但未实测** | 已落地并有单测覆盖；真机因缺 `DEEPSEEK_API_KEY`（或未构造触发条件）未跑通 | 流式 text/thinking 增量渲染、真实 bash 审批 waterfall 闭环、waterfall 应答闭环、PTY 真实命令、multipart 大结果 |
| **未接面** | 本次适配范围外，vis 不发也不收 | DeepSeek 账号登录（`account/startSignIn`）、`credentials/set`、`session/updateQueue`、`session/control` 上行控制帧、dsh 自有 `terminal/*` PTY 端点、SSE |
| **已知限制** | 平台或降级固有限制 | 平台矩阵、降级错误路径、`sessionDelete` 无端点、presets 只读 |

**已接面清单**（断言 ID 与 `00-smoke-run.log` 一一对应；证据路径相对 `task-36/`）：

| 表面 | 断言 | 证据 |
|---|---|---|
| supervisor spawn-only 托管（dsh 由 bridge 派生，绝不 adopt 外部实例） | S01、L01、E01 | `supervised/07-supervised-spawn.txt`、`live/10-supervisor-status.txt`、`gates/07-sea-live.txt` |
| 启动行解析 + launch token → cookie 交换 + 认证就绪后 `state=running` | S02、S03 | `supervised/07-supervised-spawn.txt` |
| 版本闸门 0.2.0-rc.2（CLI 与运行态双重） | V01、L16、E01 | `gates/01-version-gate.txt`、`live/23-monitor-state.txt` |
| 端口 3080 被外人占用 → `state=error, owned=false`，0 个 bridge 派生的 dsh | F01、F01b | `injections/port-3080-occupied.txt` |
| HTTP 转发 `/dsh/*` → `/api/*`（`sec-fetch-*`/Origin/Host 剥离、cookie 桥侧注入） | L02、L03、L04、L15、L16、X01、X02、X03、B04、B06、B07 | `live/*`、`injections/cross-origin.txt`、`browser/30-browser.txt` |
| WS mux 转发 `/dsh/ws` → `/api/remote.mux` + 心跳断链重连续传 | L07、F02 | `live/15-follow-snapshot.txt`、`injections/mux-heartbeat-cut.txt` |
| 登录连接（`account/getState` 经 bridge，cookie 由桥注入） | L02 | `live/11-login-connect-getState.txt` |
| 会话创建 + `selectModel` 写模型 | L05、L06 | `live/14-session-create.txt` |
| `session/follow` snapshot + 增量帧 | L07 | `live/15-follow-snapshot.txt`、`live/16-follow-frames.jsonl` |
| prompt 受理 + `MISSING_CREDENTIAL` 错误路径 + `requestId`/`rpcId` 绑定 | L08、L09、L10、L11 | `live/17-prompt-request.txt`、`live/18-missing-credential.txt` |
| 历史重载（`session/page`） | L12 | `live/19-history-page.txt` |
| 模型目录 + 切换 | L04、L06 | `live/13-model-catalog.txt` |
| 文件树（`workspaceFiles/list`） | L15 | `live/22-workspace-files.txt` |
| 会话动作（rename/archive/unarchive/pin/unpin） | L14 | `live/21-session-actions.txt` |
| Shell：bridge PTY 目录可达 | L13 | `live/20-terminal-shell.txt` |
| 状态监控（`/healthz` + supervisor `state@version` + `account/getState`） | L16 | `live/23-monitor-state.txt` |
| cookie 失效 → 带新 launch token 重交换；无 token → `DSH_COOKIE_MISSING` | F03、F04 | `injections/cookie-invalidation.txt` |
| 真实 Chromium 跨源读取、明暗主题、380px 窄屏 | B01、B02、B03、B03b、B04、B05、B06、B07 | `browser/30-browser.txt` |
| 后端切换清理、分支守卫（vitest 门） | 门 06、08 | `gates/06-dsh-branch-guard.txt`（9/9）、`gates/08-backend-switch-cleanup.txt`（55/55） |

**已接面但未实测**（成因与补救路径见 `degraded-items.md` 对应行）：

| 表面 | 状态 | 原因 |
|---|---|---|
| 流式 text/thinking 增量渲染 | 未实测 | 需已签名 key；降级模式下 turn 在任何 assistant 文本产生前就以 `MISSING_CREDENTIAL` 结束（`degraded-items.md` 行 4） |
| 真实 bash 审批（通过与驳回各一） | 未实测 | 审批由运行中的 agent 在 turn 内触发，无 turn 即无审批（行 7） |
| waterfall 应答闭环（`approval/request` → `$events/result`） | 已接面但未实测 | Todo 28 已实现并以单测 settle 断言钉死应答词汇；真机未执行（行 8），词汇见 §7.8 |
| Shell：PTY 真实命令 | 部分 | PTY 目录可达（L13）；真实命令需要一次 live turn（行 12） |
| multipart 大结果响应 | 已接面但未实测 | `app/utils/dshRpc.ts` 的 multipart 解析已用合成 fixture 单测覆盖，未做 live 探测（未读二进制文件） |

**未接面**（范围外，vis 不发也不收）：DeepSeek 账号登录（`account/startSignIn` 未触发，避免真实账号流程）、`credentials/set`（vis 不代用户写 DeepSeek key，凭据由 dsh 所在环境提供）、`session/updateQueue`（wire 为 `gateway/input-invalid`，参数结构未补探测；前端 `updateSessionMode` 抛 typed unsupported）、`session/control` 上行控制帧、dsh 自有 `terminal/create` + `terminal/follow`（Shell 走 bridge PTY，见 §14.1）、SSE（见 §15）。

**已知限制**：

1. **平台矩阵**：live QA 平台是 **Linux x64 / Node 24**。Windows 与 macOS 的 spawn 继承 kimi-web 先例（Metis #16）：bridge 按命令名派生 dsh，前提是 `dsh` 在 bridge 主机的 PATH 中；协议按 loopback `127.0.0.1:3080` 进行，与平台无关，但**未在 Windows/macOS 实机验证**。
2. **降级模式**：`DEEPSEEK_API_KEY` 缺席时，真实 LLM 对话以 `turn/end.reason.error.code=MISSING_CREDENTIAL` 失败。该错误路径完整可观测（L09/L10 双表面断言），vis 的错误展示直接消费这两个字段，但**不能据此宣称对话能力已实测**。
3. **`sessionDelete` 不存在**：§7 无 `session/delete` 端点；vis 的"删除"是本地隐藏 + 明确拒绝（`DshSessionDeleteUnsupportedError`），不是远端删除。
4. **presets 只读**：未探测到 0.2.0-rc.2 的 preset 写入端点，权限 preset 选择器为只读（`writable:false`）。
5. **协议代漂移**：rc 阶段协议随版本变化（§11），升级必须重新探测，不支持未钉版本的安装。

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
3. mux 上每条逻辑流用客户端分配的 `streamId` 标识；**服务端不存在跨连接的 streamId 记忆**，同 streamId 在新连接可直接重开（Todo 7 实测 R8）。会关闭 socket 的违规是三类：同 socket 内重复 `open`、二进制帧、非法 JSON（见 §6.2，原文"重复 open 是唯一"已订正）。

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

- 迟到帧分两种，别一概当静默（Todo 7 实测订正，`.omo/evidence/dsh-web-adapt/task-7/replay-boundary-contract.md` §4）：发向**从未打开过**的 streamId 的 item 与 **cancel 之后**到达的 item **静默丢弃**（零响应帧、socket 存活）；而对某条 follow 流发过 uplink `end` 之后再发 item，会收到 `{"code":"gateway/protocol","message":"api gateway: Remote stream uplink item after end"}` error 帧，**该流被服务端判死，此后零帧送达且无其它通知**。因此客户端对 follow 流只发 `cancel`，永不发 `end`（R13）；收到 `error` 帧的流按失败处理并换新 streamId 重建（R16）。
- 会关闭 socket 的违规共三类（Todo 7 实测订正，原文"重复 open 是唯一"不成立）：同 socket 内重复 `open` 同 streamId → `close(1008)`；二进制帧 → `close(1003)`；非法 JSON 文本 → `close(1008)`。流级违规（error 帧、静默丢弃）从不关闭 socket，三类关 socket 属客户端 bug，不重连（R14/R15）。
- 上行缓冲上限 256 KiB/流（`streamInboxBytes`），溢出以 `gateway/uplink-overflow` 失败该流。
- **心跳**：服务端每 **2s** 发 ping；客户端连续 **2 次**未回 pong 即 `terminate()`。vis 客户端必须用能自动回 pong 的 WS 实现（`ws` 库默认行为即够）。此条已真机实测：Todo 36 用裸 WS 客户端（吞 pong）观察到 8 秒内 4 次服务端 ping，回 pong 的客户端存活、吞 pong 的被终止（`task-36/injections/mux-heartbeat-cut.txt`，F02）。

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
| `skills/list` | unary | `{request:{sessionId}}` | ✅ 当前会话技能目录 `{skills:[{name,description,path?,modelInvocable}]}` |
| `fileReferences/list` | unary | `{agentId, query}` | ✅ 文件引用数组 |
| `pluginManager/listPlugins` | unary | `{}` | ✅ 插件数组，含 entryId、moduleName、enabled、fiberPhase、meta、patchId 或 readOnlyReason |
| `pluginInventory/list` | unary | `{}` | ✅ entries、agentPresets、managementAvailable |

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
| `workspace/initializeDefault` | unary | 无参 | ⚠️ 环境相关：无系统 Documents 目录时报 `gateway/internal: system Documents directory is unavailable`；Task 6 在 Linux 桌面环境实测 **200 ok**（与初版结论分歧，属环境差异） |
| `workspace/directoryPicker/list` | unary | `{request:{...}}` | ❌ http-404（Task 6 实测，此前未探测） |
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
| `job/list` | **stream** | `{request:{sessionId}}` | ❌ 经 HTTP → `signature-invalid`（必须走 mux）；✅ 经 mux 实测返回行（Task 6 复测） |
| `job/follow` | **stream** | `{request:{...}}` | ➖ |
| `job/kill` | unary | `{request:{...}}` | ➖ |

### 7.7 `workspaceFiles`（5）

| 端点 | 形态 | 参数 | 实测 |
|---|---|---|---|
| `workspaceFiles/list` | unary | `{workspaceFileScopeId(=SessionId), path}` | ✅ `{path, entries:[{name,type,size}], truncated}` |
| `workspaceFiles/stat` | unary | `{workspaceFileScopeId, path}` | ✅ `{absolutePath, version, bytes}` |
| `workspaceFiles/read` | unary | `{workspaceFileScopeId, path, range:{offset?,limit?}}` | ✅ `{absolutePath, version, bytes, offset, text, lines, eof}` |
| `workspaceFiles/readBytes` | unary | `{workspaceFileScopeId, path, options:{baseFile?, range?}}` | ✅ 完整文件通过 multipart 字节附件读取；Vis 文本预览保留 UTF-8 和末尾换行，二进制使用 base64 |
| `workspaceFiles/changes` | **stream** | `{workspaceFileScopeId, ...}` | ⚠️ 形态订正（Task 6 实测）：经 HTTP 报 `signature-invalid`、经 mux 正常出帧，**是 stream 不是 unary**（初版未标形态） |

### 7.8 特殊端点

| 端点 | 说明 |
|---|---|
| `POST /api/$events/result` | 应答 `$events` 流里的 `waterfall` 帧：`payload:{args:{clientId, eventId, outcome}}`，outcome = `{kind:"next"}` / `{kind:"result", value?}` / `{kind:"rejected", error:{name,message,code?,details?}}`（【源码】api-gateway） |

**应答词汇（Todo 28 钉死，来源为 dsh 0.2.0-rc.2 随包源码而非猜测）**：`@deepseek-ai/dsh-client-ui-approval/lib/client.js` 用字符串 `"allowed-once"` / `"rejected"` 应答；`@deepseek-ai/dsh-api-gateway/lib/client.js#dispatchWaterfall` 把监听器返回值包成 `{kind:"result", value:<value>}`，只有 `kind:"rejected"` 会被当作监听器失败从而取消事件、让 approval 服务 fail-closed 到 `"unavailable"`。因此：放行（once/always）→ `{kind:"result", value:"allowed-once"}`；驳回 → `{kind:"result", value:"rejected"}`；降级/未知应答/畸形应答 → `{kind:"rejected", error:{...}}`（终态，绝不静默丢弃）。URL 细节：`$events` 段**不可百分号编码**（`%24events` 会 404，实测，见 Task 19 记录）。

---

## 8. 事件契约

### 8.1 `$events` 逻辑流（mux 上 endpoint=`$events`，payload `{args:{}}`）

打开后：

1. 首帧 **必然**是 `{"type":"ready","clientId":"<uuid>","host":{"home":"<DSH home>"}}`（实测）——证明 Host 事件源就绪；`clientId` 用于应答 waterfall。
2. 之后两类帧：
   - `{"type":"emit","event":"<name>","args":[...]}`——广播事件，只读。
   - `{"type":"waterfall","event":"<name>","eventId":"<uuid>","agentId":"<id>","request":{...}}`——需要客户端处理并**经 `POST /api/$events/result` 应答**（如 `approval/request`、`user-questions/request`）；其他客户端应答前该事件挂起，被取消时收到 `{"type":"cancel","eventId"}`。
3. **`clientId` 每连接一新**（Todo 7 实测 R10：单次 run 内 4 个连接拿到 4 个互不相同的 id）。任何 waterfall 应答都必须用**当前连接** ready 帧里的 clientId，重连后缓存的旧 clientId 一律作废。
4. **`$events` 是每连接 at-most-once 广播，断线期事件不补送**（Todo 7 实测 R11，带 positive control：在线 create 当即收到 emit，断线期 create 后重连只收到 `ready`）。没有 cursor、没有重放，所以待决审批/提问状态**不能等重连补帧**，必须从 session 权威状态（follow snapshot 的 records + `projections.values.userQuestions.active`）重新推导。

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
- 之后为增量 `{"type":"item","streamId":"sf1","value":{...}}`（更新帧）。
- **重连语义（Todo 7 实测订正，原文"以新 snapshot 的 cursor 续传"不成立）**：`session/follow` 没有 cursor/resume 参数（typert schema 与实测一致），重连时首帧仍是从 seq 0 起的**全量 snapshot**，断线期事件全部在内（无缺口）。语义是"全量重放 + 客户端按 `event.seq` 去重合并"，不是续传；旧连接已收到的事件会被 snapshot 二次投递。因此**重连不需要用 `session/page` 补洞**（R1/R2/R4）。
- 完整回放边界契约（R1–R16：snapshot 水位、`session/page` 窗口参数语义、多流重订阅时序、迟到帧与协议违规）见 `.omo/evidence/dsh-web-adapt/task-7/replay-boundary-contract.md`，是实现 `app/composables/dshSyncStateMachine.ts` 与 `useDshMessageBridge.ts` 重连路径的依据，本文不重复其内容。

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

初版为探测期小结；Task 6 对 §7 全部端点复测、Todo 36 经 bridge 全链路复测，两轮差异已合并进来（分歧行标注来源）。

| 表面 | 状态 | 说明 |
|---|---|---|
| HTTP unary RPC（session/workspace/settings/account/terminal/workspaceFiles） | ✅ 可用 | 见 §7 实测列；Task 6 复测通过，Todo 36 经 bridge 全链路复测（L02–L16） |
| WS mux + `$events` + `session/follow` + `workspace/follow` | ✅ 可用 | ready/emit/waterfall 帧、快照+增量均验证；跨连接 streamId 可复用、clientId 每连接一新、`$events` 不补送（Todo 7，R8–R11） |
| stream 方法经 HTTP 调用 | ❌ 不支持 | 必须走 mux；Task 6 对 `job/list`、`workspaceFiles/changes` 双向确认 |
| 平铺 payload | ❌ 不支持（0.2.0-rc.2） | 必须 `{args:{...}}`；Task 6 全 `{args:{…}}` 复测通过，Todo 25 实测平铺直接 `gateway/arguments-invalid` |
| `session/skills/list`、`session/fileReferences/list` | ❌ 404 | 旧探测使用错误命名空间；正确端点为 `skills/list`、`fileReferences/list`，不可由此推断不支持 |
| `workspace/initializeDefault` | ⚠️ 环境相关 | 无系统 Documents 目录时报 `gateway/internal`；Task 6 在 Linux 桌面环境实测 **200 ok**（初版结论分歧，属环境差异） |
| `workspace/directoryPicker/list` | ❌ http-404 | Task 6 实测（初版未探测） |
| `workspaceFiles/changes` | ⚠️ stream | 经 HTTP 报 `signature-invalid`、经 mux 出帧（Task 6 实测订正形态） |
| 真实 LLM 对话 | ⚠️ 需凭证 | 未登录/无 key 时 turn 以 `MISSING_CREDENTIAL` 失败；该错误路径已双表面实测（`turn/end.reason.error.code` + attempt finish chunk，L09/L10），**完整对话（含 assistant 全文）仍未实测** |
| 模型目录 | ✅ | `session/modelCatalog`：provider `deepseek-official`；`deepseek-flash`(DeepSeek-V41-Flash)、`deepseek-v4-pro`；推理档位 `off/low/high/max`（默认 high）。信封形状为 `{default, routableProviders, groups:[{id,name,models:[{id,name,reasoning:{efforts,defaultEffort}}]}], failures}`（Todo 36 实测：1 provider / 2 models，L04） |
| 终端 | ✅ | environment/shells/list 可用；PTY 上限 `maxInputBytes:65536, maxCols:500, maxRows:200, scrollback:1000` |
| 工作区文件 | ✅ | list/stat/read 可用；scope = SessionId → 解析 cwd 为根；`read` 必须带 `range` |
| 裸 fetch 路由 | ⚠️ 部分 | `/api/file`、`/api/session.export`（ZIP 日志，实测 11.8 KB）、`/api/present.host`（桌面元数据）可用；`changes.*`/`present.open` 需 session 坐标参数，路由可达（见 §5.5）。Task 6 复测：6 条中 2 条返回 200（其余需坐标参数或桌面能力） |
| 登录 | ➖ 连接已实测 / 账号流程范围外 | `account/getState` 经 bridge 实测 `ok:true`（L02，cookie 由桥侧注入）；`startSignIn` 未触发（账号 OAuth 属范围外，见 §15） |

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
| 认证 | 文件 token（Bearer / subprotocol） | launch token → cookie（`Max-Age` 30 天；**跨重启有效属源码推断，未实测**，见 §15） |
| 回放 | WS 重连 + resync + snapshot | **无 resync 实物**（Todo 7 订正）：重连 = 按序重开全部 in-flight 流 + 从 seq 0 的全量 snapshot + 客户端按 `event.seq` 去重；`session/page` 只用于历史分页与子代理寻址，**不用于重连补洞**（R1/R4） |
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

1. **进程托管**（`bridge/processSupervisor.js`，已落地）：新增 native service 定义（`{id:'dsh', name:'DSH', command:'dsh', args:['web','--no-open','--port','3080'], probe:{type:'http', url:'http://127.0.0.1:3080/'}}`），**spawn-only，无 adopt 状态**：外部实例的 launch token 只在它自己的 stdout 上，bridge 无法认证，因此端口被占直接报错而非接管（Task 8 决策，真机见 `task-36/injections/port-3080-occupied.txt` F01）。启动时序（Todo 8 + Todo 36 S01–S03 实测）：版本闸门（`dsh --version`，不符即停子进程并提示 `npm i -g @deepseek-ai/dsh@0.2.0-rc.2`）→ 按名 spawn 子进程并接管 stdout → 解析启动行 `dsh web: http://127.0.0.1:<port>/?token=<launchToken>`（同时拿端口与 token）→ 端口漂移校验 → cookie 交换 → **认证就绪**（带 cookie 打 `POST /api/account/getState`，期待 `result.ok===true`）→ `state=running`。任一步失败只停**那一个**子进程并把状态置 `error`，不留半可用服务；状态三态即 `stopped`（未托管）/ `running` / `error`。
2. **凭据交换**（新模块，仿 `bridge/kimiWebToken.js`）：launch token → `GET /?token=` 捕获 `Set-Cookie` → 缓存 `dsh-auth-*` cookie（authority 维度）；dsh 重启后 cookie 仍有效（签名 secret 持久），失效时用新 launch token 重换。
3. **HTTP 转发**（仿 `bridge/kimiWebHttpProxy.js`）：`/dsh/*` → `http://127.0.0.1:<port>/api/*`（注意路径映射：bridge 前缀剥掉后要拼回 `/api/`）；剥掉浏览器带的 `origin`/`host`/hop-by-hop，注入 cookie；**绝不向上游泄露 bridge token**。
4. **WS 转发**（仿 `bridge/kimiWebWsProxy.js`）：`/dsh/ws` → `ws://127.0.0.1:<port>/api/remote.mux`；upgrade 时带 cookie；`connectUpstreamWebSocket` 风格裸握手、不带上行 Origin。
5. **路由注册**（`bridge/visBridgeServer.js`）：HTTP 链加 `/dsh` 分支；upgrade 链加 `/dsh/ws` 分支；`bridge/bridgeConfig.js` 加 native service 默认**关**（opt-in，dsh 仍处 rc 阶段，与三个真 sibling 的默认开不同）；`bridge/visBridgeCli.js` 如需独立端口则加默认值（复用 23004 即可）。

### 14.2 前端侧

1. **契约**（`app/backends/types.ts`）：`BackendKind` 增加 `'dsh'`；新建 `app/backends/dsh/dshAdapter.ts`，能力矩阵参考 kimi（dsh 支持 sessions/fork/archive/pin/terminal/files，**暂不支持 worktrees/todos/questions 视版本而定**）。
2. **客户端**（仿 `app/utils/kimiWeb.ts` + `kimiWebWs*.ts`）：
   - `app/utils/dshRpc.ts`：信封构造/校验（`client-request`/`server-response`）、`{args}` 包装、错误码归类、multipart 结果解析；
   - `app/utils/dshMux.ts`：mux 帧编解码、streamId 管理、ping/pong（依赖 `ws` 自动行为）、断线重连 + snapshot 续传。
3. **适配器**（`app/backends/dsh/`）：`normalize.ts`（follow 记录 → `MessageInfo`/`MessagePart`）、`handlers-*.ts`、`history.ts`（`session/page` 分页）、`bootstrap.ts`（`workspace/follow` → projects、`session/list` → sessions、首个 session follow + history）、`sessionModes.ts`（permission preset 读写）、`backendMessageSend.dsh.ts`（`session/prompt`，mode queue/steer）。
4. **事件桥**（`app/composables/useDshMessageBridge.ts`）：同时挂 `$events`（审批/账号/设置变更）与目标 session 的 `session/follow`；`approval/request` waterfall 帧经 `POST /api/$events/result` 应答（映射到现有 permission UI）。应答词汇按 §7.8 钉死的三态映射（放行 `allowed-once` / 驳回 `rejected` / 降级与未知 `kind:"rejected"` fail-closed），`user-questions/request` 与未知 waterfall 立即安全拒绝；一个 `eventId` 只答一次，host `cancel` 帧抑制迟到应答，无连接 clientId 时应答入队、ready 后flush。（Todo 28/19 落地。）
5. **注册与激活**：`app/backends/registry.ts` 加 `configureDshBackend` + `DEFAULT_DSH_BRIDGE_URL='ws://localhost:23004/dsh/ws'`；`useCredentials` 加 backendKind/URL/token 存储键；`useBackendActivation.activateDsh`；`App.vue` 登录按钮/字段/watchEffect/bootstrap。
6. **构造器绑定纪律**：照 `codexAdapter.ts` `bindBackendMethods()`（:1460）或 kimiWebAdapter 构造器逐方法 `bind(this)`——调用方会把方法当回调传出。
7. **类型契约**：JSON-RPC 响应用**实机探测的真实形状**定义 TS 类型（本项目 memory #798 的教训），mock fixture 必须来自真实 wire 数据（`.omo/evidence/dsh-adapt/`）。

### 14.3 测试与验收（照 kimi-web）

- 单测：信封编解码、normalize、history、mux 帧状态机、registry pin、bridge 边界（`app/dshHttpProxy.boundaries.test.ts`、`app/dshWsProxy.boundaries.test.ts` 等）。
- Fixtures：`.omo/evidence/dsh-adapt/04-session-follow-full.txt` 的真实 records → `app/backends/dsh/fixtures/*.jsonl`。**注意**：该 capture 与 Task 6 都是降级采集（`DEEPSEEK_API_KEY` 缺席、零 prompt），其中唯一的 `assistant/attempt` 是 `MISSING_CREDENTIAL` 错误记录；成功流、思考增量、工具调用、审批 waterfall、子代理 child、正常完成序列**无真实 fixture**，凭据版补测清单见 §15 末尾。
- Live QA（已执行，模式 `degraded`）：`.omo/evidence/dsh-web-adapt/task-36/`，41/41 断言 PASS、退出码 0。dsh 从不由测试脚本启动，全部经 `node vis_bridge.js start`（或重建的 SEA）由 supervisor 派生；本机真实 bridge 配置未被动过（test-owned `bridge.json` + `VIS_BRIDGE_STATE_DIR`）。降级路径只跑错误路径 QA（prompt → `MISSING_CREDENTIAL` 完整可观测）加全部与凭据无关的协议面，覆盖范围逐行见 §0.1 与 §15。
- 最终门（已执行，全部退出码 0）：`pnpm lint`（oxlint + vue-tsc）、`pnpm test`（Vitest 全量 4169 passed / 6 skipped，472 files）、`pnpm build`、`pnpm bridge:build`（SEA 重建，`--version` 0.8.9）。

---

## 15. 未验证项与裁定（逐行对账）

本表替代初版"未验证项"清单。裁定口径三选一，与 §0.1 一致：

- **已实测**：Todo 36（或 Todo 6/7 探针）有 PASS 断言，证据指到文件与断言 ID。
- **已排除（范围外）**：vis 适配明确不做，vis 不发也不收；记录在此以免后来者误以为漏做。
- **已知限制（降级/平台）**：面已落地但因缺凭据、缺触发条件或平台未覆盖而未跑通，公开文档必须标注。

| 项 | 裁定 | 依据 / 证据 | 若要补测 |
|---|---|---|---|
| DeepSeek 账号登录全流程（`account/startSignIn` → 事件 → 对话） | 已排除（范围外） | 写入型账号 OAuth 流程，vis 不接管；登录连接面（`account/getState`，只读）已实测：`task-36/live/11-login-connect-getState.txt`（L02） | 提供真实账号后由人手工走一遍；产品面另行立项 |
| `credentials/set` 写入 API key 后重放 prompt | 已知限制（降级） | `DEEPSEEK_API_KEY` 缺席（`task-36/00-run-context.txt`、`degraded-items.md` 表头）；vis 不代用户写 DeepSeek 凭据，凭据由 dsh 运行环境提供；缺 key 的错误路径已实测：`live/18-missing-credential.txt`（L09/L10） | 在带 key 的环境发 1 条 prompt，断言 `turn/end.reason.kind="completed"` + `assistant/message` 全文 |
| `terminal/create` + `terminal/follow`（dsh 自有 PTY 全链路） | 已排除（范围外） | Shell 走 bridge PTY（Metis #15），dsh `terminal/*` 端点不接；PTY 目录可达已实测：`live/20-terminal-shell.txt`（L13） | 若改为消费 dsh PTY，先补 `request` 结构探测 |
| `session/control` 流语义 | 已实测（开流与 baseline）+ 已排除（上行控制帧） | Todo 6 探针打开 `session/control` 并捕获 baseline 帧（`.omo/evidence/dsh-web-adapt/task-6/degraded-capture-record.md` "What WAS verified"）；上行控制帧 vis 不发 | 需要远端控制会话时再补帧类型测量 |
| `session/updateQueue` 参数 | 已排除（范围外） | 此接口未接入；模式改用 `agentPresets/list` / `select`，命令改用会话级 `commands/list` / `execute`，不依赖队列接口 | 按对应原生接口操作 |
| waterfall 应答闭环（`approval/request`、`user-questions/request`） | 已知限制（降级） | Todo 28 已实现并以单测 settle 断言钉死（`dshPermissions.test.ts` 19 例，`.omo/evidence/dsh-web-adapt/task-28.txt`）；真机未执行：审批由运行中的 agent 在 turn 内触发，无 turn 即无审批（`degraded-items.md` 行 8） | 凭据版 + bash 类工具调用触发审批，走通过与驳回各一次；应答词汇已钉死，见 §7.8 |
| 多客户端 / 多 observe 同时 follow 同一 session | 已实测（受限） | Todo 7 探针以 2–3 条并发 mux 连接 follow 同一 session，snapshot 与增量均正常（`.omo/evidence/dsh-web-adapt/task-7/replay-boundary-contract.md` §3.1 第 6 条）；另测：同 streamId 跨连接可复用（R8）、`$events` clientId 每连接一新（R10） | 限制：单进程多连接，非独立第三方客户端的严格证明；跨连接广播另有 R11（`$events` 不补送） |
| cookie 跨重启有效性 | 已知限制（未实测） | `degraded-items.md` 行 15：重启须由 supervisor 发起并重建 launch-token 交换，降级 run 观察不到端到端过程。已实测的是失效重交换：`injections/cookie-invalidation.txt`（F03/F04）。§4.1 的"跨重启有效"仍是源码推断（30 天 Max-Age + authority 键） | supervisor 重启 dsh 后用旧 cookie 打 `/api/account/getState` |
| 文件 multipart 响应 | 已实测 | `workspaceFiles/readBytes` 使用必填 `options:{}` 返回 metadata 和 `bytes-0`；真实 `package.json` 已在文件窗口完整显示，文本和二进制保留完整字节 | 证据 `.omo/evidence/dsh-provider-mcp-20261003/file-package-green.png` |
| SSE 传输 | 已排除（范围外） | 0.2.0-rc.2 只注册 `/api/remote.mux` 一条 upgrade 路由、无 `text/event-stream` 端点（本版实测）；`cordis.patch.yml` 里 "fetch/SSE client" 注释已过时 | 无需动作；若未来版本注册 SSE 路由再评估 |

**仍欠的 live fixture**（Task 6 记录，需凭据版补测，缺一项就不写一项）：成功的 assistant 文本增量流、思考增量帧、工具调用/结果、审批 waterfall 帧（含 `sessionId`/`eventId` 身份与 resolve/cancel 生命周期）、子代理 child 的 `session/page` 记录、`turn/end.reason.kind="completed"` 的正常完成序列、`user-questions/request` waterfall 帧与安全拒绝应答。清单见 `.omo/evidence/dsh-web-adapt/task-6/degraded-capture-record.md`。

---

## 15.1. 供应商模型配置与原生发现

供应商二级编辑页使用模型卡片配置 ID、显示名称、上下文窗口、最大输出 Token 和图片输入；文本输入保留为必需项，不再提供模型 JSON 编辑框。未编辑的模型扩展字段原样保留。保存仍经 `settings/mutate` 的 `expectedRevision` 检查，恢复默认模型通过取消 `models` 覆盖实现。

模型详细配置还支持 `reasoningEfforts`：继承模型目录时取消覆盖，关闭思考能力时写入 `false`，自定义时勾选模型支持的等级并填写接口对应值（如 `max: ultra`）。`off` 可不发送参数；其他等级必须填写值，且自定义至少选一项。提供商默认强度 `reasoning` 单独通过 schema 提供的下拉选项设置；取消选择恢复运行时默认值。保存后刷新原生目录，底部选择器使用模型实际返回的可选强度。预算、请求头、超时和其他高级配置不开放。

“获取可用模型”调用原生 `llm/discoverModels`，参数为 `{settingsNs, request:{provider, baseURL?, api?, apiKey?}}`。其中 API key 仅在用户填写替换值时作为本次请求参数传递；已有凭据由 DSH 在服务端解析。原生已安装目录优先于网络探测；自定义端点由 DSH 访问其模型列表。返回的 `inputModalities` 按设置 schema 映射到 pi-ai 的 `input` 或 DeepSeek 的 `inputModalities`。

发现结果支持搜索、全选和批量添加，已有模型按 ID 去重；添加仅改变草稿，点击保存才写入。提供加载、空结果、失败和重试状态，切换端点或关闭页面会中止请求并忽略旧结果，单次发现最多等待 30 秒。未提供发现能力的 DSH 插件会显示原生错误，仍可通过模型卡片手动添加。

供应商配置保存后的刷新会重新读取原生模型目录，不再返回适配器的旧缓存；第三方模型名称更新、新模型加入都会进入共享模型选择器。模型显示名使用原生 `name`，调用仍使用独立的供应商 ID 和模型 ID。

发送前必须等待原生 `session/selectModel` 确认本次选择的供应商、模型和推理档位，然后才调用 `session/prompt`。模型 ID 中的 `/`、`:` 原样保留；无法找到模型或同一裸 ID 对应多个供应商时拒绝发送，不回退到首个供应商或默认 DeepSeek。模型和推理设置写入按会话串行，发送阶段不再携带原生协议不支持的空 `model.presetName` 字段。

原生验证脚本为 `.omo/evidence/dsh-models-discovery/native-probe.mjs`：使用临时 `DSH_HOME`，验证实际 Vis 配置客户端读取原生 schema、41 个 OpenAI 内置目录模型、本地兼容端点的成功／空结果／401，以及发现前后配置值与 revision 不变。独立的名称场景仅在该临时配置中创建测试供应商，验证模型 ID `vendor/vision-v2` 与显示名 `My custom vision model` 分开返回。结构化结果在同目录 `native-result.json`；没有改动用户配置，也没有访问付费推理接口。

同一探针使用实际 Vis 发送逻辑和适配器，在两个临时会话中分别选择 `vendor/vision-v2` 和 `vendor/text:latest`，本地 OpenAI 兼容服务捕获的请求 `model` 与所选 ID 完全一致。移除已缓存模型后的原生拒绝场景也确认没有继续发送或默认模型回退。

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

2026-10-03 MCP/LSP 接口复核（DSH 0.2.0-rc.2）：原生 `dsh-mcp-client` 支持 stdio 与 Streamable HTTP，并通过工具注册及资源服务向 agent 提供 MCP；该插件及 `dsh-mcp-resources` 没有 Remote 方法，不公开连接列表、状态、连接或断开接口。隔离运行时的 `mcp/list`、`mcp/status`、`mcp/getStatus`、`mcpClient/list`、`mcpClient/status` 均为 HTTP 404；`pluginManager/listPlugins` 正常返回，已有插件管理继续用于查看与切换 MCP 插件启用状态，不能把插件 active 宣称为 MCP connected。

安装包未提供 LSP 服务或语言服务器插件，API 控制器中也没有 LSP 注册；隔离运行时 `lsp/list`、`lsp/status`、`lsp/getStatus` 均为 HTTP 404。状态监控保留 MCP/LSP 页签，明确写出当前版本不支持 MCP 连接监控接口及 LSP 接口，取代“尚未验证”的说明。此结论结合当前安装版的完整接口源码与运行时核对，不以单次 404 判定所有未知能力；升级 DSH 后需重新核对。

2026-10-03 权限与账号复核：`permissionPresets/catalog {}` 返回当前部署的预设选项；`commands/list {agentId}` 确认 `permission` 命令后，可通过 `commands/execute {agentId,line:"/permission <preset>",submittedAttachments:[]}` 修改当前会话的权限预设。此命令同时改变沙箱与审批策略；未验证到分别修改这两项的远端入口。Vis 仅展示实时目录中存在的预设，命令失败时显示错误，不乐观伪造状态。

`dsh --help` 没有 login 命令。账号 API 提供 `account/startSignIn`（client、callbackOrigin、loginSource:web|desktop）；官方 Web/桌面账号登录与提供商 API 密钥认证独立，账号 signed-out 不代表 API 密钥不可用。状态面板不启动账号登录或修改凭据。
