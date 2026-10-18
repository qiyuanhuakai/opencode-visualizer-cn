# 统一运行环境（Unified Runtime）

v0.9.0-alpha 引入统一运行环境：客户端经一个 Bridge 入口连接，按 target 访问执行环境、全部来源与协作任务。本文描述其协议表面、五类来源的**实测能力与版本矩阵**，以及各来源专属文档的位置。

本文的每个能力数字都来自落地的 QA 证据（E23 在真实 headless Chromium 中用真实 `useRuntimeCapabilities` + 真实驱动解析），版本常量来自源码常量，均可在文中标注处核对。**文档描述存在不代表当前版本实际支持。**

## 1. 连接模型

- **一个入口**：客户端只持有管理端的一条 `/runtime` 逻辑 WebSocket（managed remote 模式；local 模式两者同进程）。
- **显式 target**：所有请求显式携带 target，无需全局连接所有保存的主机；连接活动 profile，恢复的 Thread 按需连接其已授权 target。
- **稳定身份**：`environmentId`（目标持久 UUID）、`instanceId`（每次 Bridge 启动 UUID）、`epoch`（每次重建事件日志改变）、`connectionProfileId`、`harnessInstanceId`。`SessionRef = {environmentId, harnessInstanceId, nativeSessionId}`；`SessionKey` 是 JSON 元组的 base64url 编码。不按 remote URL、branch、原生 projectID 或临时 tunnel port 合并。
- **断线与重放**：snapshot 为数据库 revision 下的分页摘要与水位，事件从该水位接续；trim 的旧 cursor 触发 `replay_required` 重建快照，不静默丢终态。

## 2. `/runtime` v1 协议表面

帧契约（完整清单见 [migration-v090.md](./migration-v090.md) 第 2 节）：

- `hello{instanceId, capabilities}` 握手；`request{id, method, target, params, idempotencyKey?}`；`result{id, ok, result|typedError}`，成功 `phase` 为 `read` / `durable-accepted` / `native-executed`；`event{target, epoch, seq, entityRevision, scope, type, payload}`；独立 binary channel。
- 固定错误码：`invalid_request` / `unsupported` / `version_mismatch` / `unauthorized` / `conflict` / `cancelled` / `timeout` / `source_unavailable` / `reconcile_required` / `replay_required`。
- 已注册方法族（`shared/runtime/capabilities.js` 的 `METHODS`）：`runtime.history.*`、`runtime.target.attach/detach`、`runtime.snapshot*`、`runtime.entity.resolve`、`runtime.observer.*`、`runtime.channel.*`、`runtime.pty.*`、`session.*`、`interaction.respond`、`harness.*`（models/providers/auth/settings/skills/mcp/commands/usage）、`native.extension`。
- **typed native extension**：可选原生能力（rename/archive/delete/fork/revert/compact 等）经能力与扩展声明授予，未声明的调用返回 `unsupported`，UI 不伪造能力。

## 3. 五来源能力/版本实测矩阵

能力列为 E23 在真实 Chromium 中实测解析的结果（共 29 项可控件的支持集合），版本列为源码常量或实测版本。**某来源不支持某项时，UI 显示该来源名称与具体未声明项，而不是静默隐藏。**

| 来源 | 实测版本/协议代 | 支持能力（实测，共 29 项） | 未支持（项数） | 专属文档 |
|---|---|---|---|---|
| OpenCode | `1.18.34`（`OPEN_CODE_VERSION`） | 19：authenticateAgent、createAgentAuthPty、getGlobalConfig、getGlobalHealth、getLspStatus、getMcpStatus、getPluginStatus、getSessionStatusMap、getSkillStatus、listAgentAuthMethods、listAgents、listCommands、listProviderAuthMethods、listProviders、setProviderAuth、updateGlobalConfig、updateMcp、updateSkill、writeConfigValue | 10 | [docs/omo.md](./omo.md) |
| Codex | `0.160.0`（`CODEX_PROFILE`，绑定本地验证过的 App Server schema） | 14：codex.account、codex.models、codex.providerCapabilities、codex.rateLimits、codex.usage、getGlobalConfig、getGlobalHealth、getMcpStatus、getPluginStatus、getSkillStatus、listProviders、updateGlobalConfig、updateSkill、writeConfigValue | 15 | [docs/codex.md](./codex.md) |
| ACP | v1 | 11：authenticateAgent、createAgentAuthPty、getGlobalConfig、getGlobalHealth、getMcpStatus、listAgentAuthMethods、listAgents、sendCommand、setPluginEnabled、updateGlobalConfig、updateMcp | 18 | [docs/omp-rpc.md](./omp-rpc.md) |
| Kimi Web | `2.0.2`（`kimi --version`，见 [docs/kimi-2.0.2.md](./kimi-2.0.2.md)） | 5：getGlobalConfig、getGlobalHealth、getSkillStatus、updateGlobalConfig、updateSkill | 24 | [docs/kimi.md](./kimi.md) |
| DSH | `0.2.0-rc.2`（钉版本协议代） | 5：getGlobalConfig、getGlobalHealth、getMcpStatus、updateGlobalConfig、updateMcp | 24 | [docs/dsh.md](./dsh.md) |

要点：

- **能力差异是真实的，不是缺陷**：原生特色不压成最低共同能力。缺失能力以来源名称明确呈现（E23：渲染 "kimi-web (…): kimi-web does not declare the \"setProviderAuth\" operation" 且 Connect 禁用）。
- **DSH 只支持协议代 `0.2.0-rc.2`**：版本不符时 bridge 拒绝托管并给出安装命令；bridge 侧默认不托管（opt-in）。
- **OpenCode 的发现走受控只读枚举**：本机正式支持档必须有已验证的无损枚举路径；不能证明时用同用户官方本地存储的只读摘要枚举（不修改原生数据、不读消息），仅用于 discovery，动作仍走 API。

## 4. 驱动最小接口

驱动实现 `inspect/listSessionPage/getSession/readHistoryPage/createSession/send/cancel/respondInteraction/subscribe/close`；可选能力经 capabilities 与 typed native extension 声明。`inspect` 返回 `supported/disabled/missing/auth-required/starting/ready/failed` 与协议版本。列表完整性由驱动报告 `complete|partial|unsupported` 加 reason/cursor，一页异常不替整源宣告 complete。

## 5. 相关文档

- 升级与兼容说明：[migration-v090.md](./migration-v090.md)
- SSH/Slurm 远程执行：[remote.md](./remote.md)
- Host Thread 与协作：[collaboration.md](./collaboration.md)
- HTTP/WS 端点参考：[API.md](./API.md)
- 测试组织：[testing.md](./testing.md)
