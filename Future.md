# Future 未来执行说明

本文件用于细化 `RoadMap.md` 中的 **vis-bridge 模块化本地桥接服务器**，重点回答下面几个问题：

- 为什么 vis-bridge 要做成模块化。
- 为什么这里说的“模块化”主要是为了 **按需接入 provider 与 opencode plugin**，而不是先做一个开放插件平台。
- 这个桥应该先做什么、后做什么，怎样一步步落地，避免一开始把系统做重。

---

## 1. 目标与边界

### 1.0 委派执行原则

本文件未来很可能会被直接交给执行型 agent 使用，因此这里明确增加一组**强约束执行原则**。

如果执行者没有额外说明，就默认遵守下面这些规则：

1. **一次只推进一个 phase。**
   - 不要在同一个任务里同时实现 Phase 1、Phase 2、Phase 3。
   - 当前 phase 未验收前，不要跳到后续 phase。

2. **先做 contract，再做 runtime。**
   - 如果文档、类型、事件模型还没定，不允许直接写 provider 实现。

3. **模块化不等于平台化。**
   - 看到“plugin”“按需加载”时，不要擅自实现插件市场、远程下载、动态执行任意包。

4. **bridge 第一阶段不是 OpenCode server 完整替代品。**
   - 不要试图一次复刻全部 REST、SSE、PTY、权限、工作区、Provider 管理行为。

5. **默认优先 Codex。**
   - 如果没有明确指定别的 provider，第一阶段只验证 Codex provider 闭环。

6. **plugin 缺失必须是可观测状态，不是致命错误。**
   - 缺失 plugin 时显示 unavailable，而不是让 bridge 启动失败。

7. **除非任务明确要求，否则不要把 `vis-bridge/` 接入现有构建。**
   - 骨架目录是为了稳定接口，不是要求立即纳入当前前端打包链路。

8. **不要在未验证 contract 之前做 UI 扩展。**
   - 先保证 API 和事件能跑通，再讨论 Status Monitor、Provider 面板、Plugin 面板的增强。

### 1.1 目标

vis-bridge 的目标是：

1. 在 **WSL / 本地 Linux 环境** 中统一托管多个 agent CLI。
2. 给 Electron / WebUI 暴露一个稳定的、前端友好的 **统一 API + 统一事件流**。
3. 在桥这一层处理 provider 差异，包括：
   - CLI 是否存在
   - 版本是否可用
   - 登录态 / 环境变量是否满足
   - 流式输出格式差异
   - session 恢复能力差异
   - approval / tool / error 事件差异
4. 支持 **按需加载 opencode plugin**，即：
   - 插件不存在时不阻塞 bridge 启动
   - 插件存在时再注册其能力
   - 仅在当前会话 / 当前 provider / 当前项目需要时加载

### 1.2 非目标

第一阶段不要做下面这些事情：

1. 不做开放式第三方插件市场。
2. 不做任意脚本热插拔执行平台。
3. 不做自动多 provider 编排器（例如一条消息自动切换 Claude → Codex → Gemini）。
4. 不强求第一阶段保留 OpenCode server 的全部行为兼容。
5. 不把 PTY / 终端复用当成第一阶段阻塞项。

一句话：

> 第一阶段先做 **稳定 bridge**，不是做“AI IDE 平台内核”。

---

## 2. 为什么要模块化

这里的“模块化”不是为了追求抽象美观，而是因为 vis-bridge 需要面对两类天然不稳定输入：

### 2.1 Provider 天然是可缺失的

本机环境不一定同时安装：

- `codex`
- `claude`
- `gemini`

如果 bridge 启动时把三者都当成硬依赖，会导致：

- 某个 CLI 缺失时 bridge 无法启动
- 某个 CLI 升级或行为变化时影响整个 bridge
- 用户只想用一种 provider，却被其他 provider 的错误拖垮

所以 provider 必须是 **可探测、可降级、可单独禁用** 的模块。

### 2.2 OpenCode plugin 更适合按需加载

你提出模块化的真实原因是：桥上未来还想接一些 opencode plugin，但这些 plugin 很可能：

- 根本没有安装
- 只在某些项目里存在
- 只在某些 provider 下才有意义
- 启动成本较高
- 依赖额外环境变量 / 二进制 / MCP 服务

因此 plugin 更应该被视为：

> **桥侧的可选能力源**，而不是 bridge 启动时必须全部拉起的常驻组件。

这也是为什么应该做 **受控模块化 + 按需加载**，而不是直接做通用插件平台。

---

## 3. 推荐架构

建议把 vis-bridge 设计成四层：

```text
UI Layer
  Electron / WebUI

Bridge API Layer
  HTTP API / SSE / 可选 WS

Bridge Core Layer
  SessionManager
  EventNormalizer
  CapabilityRegistry
  ProviderRouter
  PluginResolver

Provider / Plugin Modules
  providers/codex
  providers/claude
  providers/gemini
  plugins/*
```

### 3.1 Provider 模块职责

每个 provider 模块只做四件事：

1. **probe()**
   - 检查 CLI 是否存在
   - 检查版本
   - 检查运行前提（登录态、环境变量、必要目录）

2. **capabilities()**
   - 是否支持 streaming
   - 是否支持 session resume
   - 是否支持 approval
   - 是否支持 structured output
   - 是否支持 tool events

3. **createSession() / resumeSession() / sendPrompt()**
   - 封装 provider 的实际执行

4. **normalizeEvent()**
   - 把 provider 原始事件转成 bridge 统一事件

### 3.2 Plugin 模块职责

plugin 模块不要直接拿到前端协议层，而是只向 bridge core 暴露能力：

1. 插件是否存在
2. 插件的加载前提
3. 插件可以贡献什么：
   - tool
   - command
   - context enricher
   - metrics collector
   - status source

4. 插件如何被卸载或跳过

### 3.3 Bridge Core 必须统一的东西

不管底层接的是 Codex / Claude Code / Gemini / OpenCode plugin，bridge core 对前端都只暴露统一模型：

- `ProviderInfo`
- `SessionInfo`
- `MessageChunk`
- `ToolEvent`
- `ApprovalRequest`
- `PluginStatus`
- `BridgeHealth`

不要把 provider 原生事件直接透传给前端。

---

## 4. 统一事件模型建议

推荐先收敛成下面这组事件，足够支撑第一阶段 UI：

- `provider.updated`
- `plugin.updated`
- `session.created`
- `session.updated`
- `session.completed`
- `session.error`
- `message.started`
- `message.delta`
- `message.completed`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `approval.requested`
- `approval.resolved`

如果 provider 原生事件过多，桥里做两步：

1. provider 内部先解析原始事件
2. core 再输出统一事件

这样后面即使 provider 行为变化，也只改 provider adapter，不拖累前端。

---

## 5. Provider 与 Plugin 的加载策略

这是整个 vis-bridge 最关键的策略。

### 5.1 启动时只做轻探测，不做全量启动

Bridge 启动时：

1. 扫描内建 provider：`codex` / `claude` / `gemini`
2. 调用各自 `probe()`
3. 记录能力和不可用原因
4. 扫描已知 plugin 来源
5. 仅建立 **registry**，不要启动所有 provider session，不要拉起所有 plugin 进程

输出结果类似：

```json
[
  {
    "id": "codex",
    "available": true,
    "version": "0.x",
    "capabilities": {
      "streaming": true,
      "resume": true,
      "approval": true
    }
  },
  {
    "id": "claude",
    "available": false,
    "reason": "binary-not-found"
  }
]
```

### 5.2 Provider 在“会话创建时”才真正激活

例如：

- 用户创建一个 Codex session
- bridge 才启动 Codex provider runtime
- 该 session 结束后，provider runtime 可以：
  - 保活一段时间
  - 或者销毁

不要在 bridge 启动时把所有 provider 都常驻拉起。

### 5.3 Plugin 按三种方式加载

#### A. 启动即注册，使用时执行

适合：

- 只有元数据成本
- 执行成本低
- 不依赖额外进程

#### B. 会话级加载

适合：

- 只对某类 provider 有意义
- 只在当前项目需要
- 需要读取项目配置或工作目录

#### C. 真正按调用加载

适合：

- 大概率不存在
- 依赖额外命令 / MCP / 网络服务
- 启动慢
- 只会被少数命令触发

这是未来接入 opencode plugin 时最优先考虑的模式。

---

## 6. Plugin 来源与解析顺序建议

建议 vis-bridge 统一支持三类 plugin 来源：

1. **Bridge 自身配置**
   - 用于 bridge 级别的显式启用/禁用

2. **项目配置 / OpenCode config**
   - 参考现有 `plugin: string[]` 概念
   - 允许从项目配置里读 plugin paths

3. **约定路径自动发现**
   - 仅扫描少量固定位置
   - 不做全盘递归搜索

推荐解析顺序：

1. Bridge 全局禁用列表
2. Bridge 全局显式启用列表
3. 当前项目声明的 plugin paths
4. 自动发现路径
5. 去重
6. probe
7. 注册可用插件

### 6.1 设计要求

plugin 路径不存在时：

- 不报致命错误
- 只记录状态
- 在 UI 里显示“未安装 / 不可用 / 缺少依赖”

这点非常重要，因为这正是按需加载的价值所在。

---

## 7. 第一阶段不要做“通用插件平台”

为了避免系统做重，第一阶段应该采用下面这条原则：

### 7.1 做内建模块注册，不做任意扩展执行

可以做：

- `providers/codex`
- `providers/claude`
- `providers/gemini`
- `plugins/opencode-magic-context`
- `plugins/gnhf`
- `plugins/tokscale`

不建议第一阶段做：

- 任意 npm 包自动执行
- 运行时下载插件
- 任意 JS 文件动态 eval
- 用户自定义 bridge 远程插件源

### 7.2 模块化 ≠ 平台化

这里的模块化是为了：

- 隔离风险
- 控制依赖
- 按需加载
- 易于调试

不是为了构建一个无限可扩展的宿主平台。

---

## 8. 可执行实施流程

下面这部分是建议按顺序执行的落地流程。

### 8.0 Phase 执行规则

为避免能力一般的 agent 一次性做太多，执行时必须显式遵守以下规则：

1. 每次任务开始前，先声明本次只处理哪个 phase。
2. 每次任务结束时，必须给出：
   - 本次完成范围
   - 本次未做范围
   - 下一 phase 是什么
3. 如果任务范围横跨多个 phase，默认拆成多个任务，而不是一次做完。
4. 如果发现某项实现会引入 PTY、开放插件平台、自动多 provider 编排，默认判定为**越界设计**，必须回退到当前 phase 范围内。

---

### Phase 0：定协议，不写 provider 逻辑

目标：先把 bridge 的“对前端契约”定下来。

#### 要做的事

1. 定义 bridge API 草案
   - `GET /bridge/health`
   - `GET /bridge/providers`
   - `GET /bridge/plugins`
   - `POST /bridge/session`
   - `POST /bridge/session/:id/prompt`
   - `POST /bridge/session/:id/approval`
   - `GET /bridge/events`

2. 定义统一数据结构
   - ProviderInfo
   - PluginInfo
   - SessionInfo
   - EventEnvelope

3. 明确哪些字段是“桥自己的”，哪些字段是“provider 透传 metadata”

#### 产出物

- `docs/bridge-api.md`
- `docs/bridge-events.md`
- TypeScript 类型定义

#### 完成标准

- 不接任何真实 CLI，也能用 mock 数据跑通前端联调

#### 禁止事项

- 不实现真实 provider 进程调用
- 不引入任何 CLI 二进制依赖
- 不补 PTY / shell websocket
- 不让 API 文档膨胀为完整 OpenCode server 兼容文档

---

### Phase 1：只接 Codex，验证最小闭环

目标：先做一个最容易成功的 provider。

#### 要做的事

1. 实现 `providers/codex`
2. 支持：
   - probe
   - create session
   - send prompt
   - streaming output
   - basic error mapping
3. 将事件映射到统一事件模型
4. 前端最小接入：
   - provider 列表
   - session 创建
   - message streaming

#### 暂时不做

- approval 完整闭环
- PTY
- plugin 按需加载
- 多 provider 自动切换

#### 禁止事项

- 不同时接入 Claude 和 Gemini
- 不实现 provider 自动路由
- 不引入 bridge 插件平台

#### 完成标准

- 在 Windows UI 连 WSL bridge 的情况下，Codex session 可以稳定创建、输出、结束

---

### Phase 2：引入 Provider Registry

目标：让 bridge 具备多 provider 能力，但仍保持简单。

#### 要做的事

1. 新增 `CapabilityRegistry`
2. 新增 `ProviderRouter`
3. 加入 `providers/claude`
4. 加入 `providers/gemini`
5. `GET /bridge/providers` 返回每个 provider 的：
   - availability
   - reason
   - capabilities
   - version

#### 决策规则

- session 创建时必须显式选择 provider，或使用默认 provider
- 一个 session 生命周期内不自动切 provider

#### 完成标准

- 缺少某个 CLI 时 bridge 仍能启动
- UI 能正确显示 provider 可用 / 不可用原因

#### 禁止事项

- 不做自动多 provider 编排
- 不做“根据任务类型自动切 provider”
- 不因为 provider registry 存在就强制所有 provider 常驻启动

---

### Phase 3：引入 Plugin Resolver（只做按需加载，不做平台）

目标：支持按需接入 opencode plugin。

#### 要做的事

1. 实现 `PluginResolver`
2. 设计 `PluginModule` 接口：
   - `probe()`
   - `describe()`
   - `supports(context)`
   - `activate(context)`
   - `dispose()`

3. 支持 plugin 来源：
   - bridge config
   - project config / opencode plugin paths
   - fixed discovery paths

4. 支持三种状态：
   - available
   - unavailable
   - disabled

5. 支持两种加载方式：
   - session start 时加载
   - first use 时加载

#### 关键原则

- 不因为 plugin 缺失而导致 bridge 启动失败
- 不把所有 plugin 常驻拉起
- 不让 plugin 直接污染 bridge API 层

#### 禁止事项

- 不做远程插件下载
- 不做运行时安装任意依赖
- 不执行来源不明的脚本型插件
- 不把 plugin resolver 扩写成“插件生态系统”

#### 完成标准

- 任意一个 plugin 缺失时，bridge 仍可工作
- 已安装 plugin 可以在需要时被加载并贡献能力

---

### Phase 4：补 approval / tools / richer status

目标：让 bridge 更接近 OpenCode / vis 需要的交互体验。

#### 要做的事

1. 打通 approval.requested / approval.resolved 流程
2. 打通 tool.started / tool.completed / tool.failed
3. 把 provider / plugin 状态并入 status monitor
4. 对错误做标准化分类：
   - binary-not-found
   - auth-missing
   - startup-failed
   - session-crashed
   - plugin-missing
   - plugin-runtime-error

#### 完成标准

- 前端可以明确区分 provider 不可用、plugin 不存在、会话执行失败三类问题

---

### Phase 5：再评估是否需要 PTY / 编辑器 / WebUI 编辑能力

目标：把重交互能力放到最后。

原因：

- 这部分跨 Windows / WSL / Electron 复杂度最高
- 它不是 bridge 的最小核心价值

第一阶段 bridge 的核心价值是：

> 统一 provider + 统一 session + 统一事件流 + 按需 plugin 能力

不是“复刻本地终端”。

---

## 9. 建议的数据结构

### 9.1 ProviderInfo

```ts
type ProviderInfo = {
  id: string;
  label: string;
  available: boolean;
  version?: string;
  reason?: string;
  capabilities: {
    streaming: boolean;
    resume: boolean;
    approval: boolean;
    tools: boolean;
    structuredOutput: boolean;
  };
};
```

### 9.2 PluginInfo

```ts
type PluginInfo = {
  id: string;
  source: 'bridge-config' | 'project-config' | 'discovery';
  path?: string;
  available: boolean;
  loaded: boolean;
  reason?: string;
  contributes: Array<'tool' | 'command' | 'context' | 'status' | 'metrics'>;
};
```

### 9.3 EventEnvelope

```ts
type EventEnvelope = {
  id: string;
  time: number;
  sessionID?: string;
  providerID?: string;
  pluginID?: string;
  type: string;
  data: Record<string, unknown>;
};
```

---

## 10. 验收标准

在 `vis-bridge` 第一轮可用之前，至少满足下面这些条件：

### 基础能力

- [ ] bridge 可单独启动
- [ ] 缺少某个 provider 时 bridge 不崩溃
- [ ] UI 能读取 provider 列表
- [ ] UI 能创建至少一种 provider 的 session
- [ ] session 支持流式输出

### 模块化能力

- [ ] provider 是独立模块
- [ ] plugin 是独立模块
- [ ] plugin 缺失只影响自身状态，不影响 bridge 主流程
- [ ] plugin 支持延迟加载

### 可观测性

- [ ] provider probe 结果可见
- [ ] plugin probe 结果可见
- [ ] session 执行错误可见
- [ ] 加载失败原因可见

### 远程场景

- [ ] Windows UI 可连接 WSL bridge
- [ ] bridge 地址可配置
- [ ] 断连后可恢复状态或重新创建 session

---

## 10.1 委派给执行 agent 时的任务模板

如果后续要把这项工作交给能力一般一些的 agent，建议直接使用下面这种任务模板，减少误解。

### 模板

```md
目标：只推进 vis-bridge 的 <某一个 phase>。

必须遵守：
1. 只做当前 phase，不进入后续 phase。
2. 不扩展为开放插件平台。
3. 不把 vis-bridge 接入现有构建，除非任务明确要求。
4. 不补 PTY，除非当前任务明确要求。
5. 所有新增命名必须沿用现有文档中的 provider / plugin / providerID / sessionID 术语。

本次要做：
- ...
- ...

本次不要做：
- ...
- ...

完成后必须输出：
1. 做了什么
2. 没做什么
3. 哪些内容留给下一 phase
4. 是否满足当前 phase 的完成标准
```

### 推荐用法

- 写文档任务时，附上 `Future.md` + `docs/bridge-api.md` + `docs/bridge-events.md`
- 写骨架任务时，再附上 `vis-bridge/README.md` 和 `vis-bridge/src/contracts/*`
- 写实现任务时，只附当前 phase 需要的文件，避免 agent 因为看见后续 phase 而过度发挥

---

## 10.2 常见误解与纠偏

为了让较弱的 agent 也能稳定执行，这里列出最常见的误解。

### 误解 1：既然是 bridge，就要兼容全部 OpenCode API

纠偏：

- 错。第一阶段 bridge 只需要支撑最小闭环。
- 契约以 `docs/bridge-api.md` 和 `docs/bridge-events.md` 为准，不以“完整兼容 OpenCode”为目标。

### 误解 2：既然要模块化，就应该做插件平台

纠偏：

- 错。这里的模块化首先是为了 provider 可缺失、plugin 大概率不存在、能力需要按需加载。
- 第一阶段只允许受控模块注册，不允许扩成平台。

### 误解 3：既然有多个 provider，就应该自动路由

纠偏：

- 错。前几阶段都默认“一个 session 绑定一个 provider”。
- 自动路由属于后续高级能力，不是当前目标。

### 误解 4：既然 bridge 最终要远程使用，就该先做认证、面板、状态监控增强

纠偏：

- 错。先稳住 contract、session、event stream，再补安全和 UI 增强。

### 误解 5：既然有 `vis-bridge/` 骨架，就应该立即接入根工程

纠偏：

- 错。当前骨架只是为了固定接口与目录，不代表必须立刻接入现有前端构建。

---

## 11. 明确建议

### 应该做的

1. 先做 **bridge core + codex provider**
2. 再做 provider registry
3. 再做 plugin resolver
4. 把 opencode plugin 视为“可选能力模块”
5. 把“按需加载”作为默认策略

### 不应该急着做的

1. 不要先做开放插件生态
2. 不要先做自动多 provider 编排
3. 不要先做 PTY 重交互
4. 不要让 provider 原生协议直接泄漏到前端

---

## 12. 一句话决策

vis-bridge 的模块化方向是正确的，但它的目标应该被明确限定为：

> **让 bridge 在 provider 和 opencode plugin 大概率缺失、行为不一致、只在部分项目存在的前提下，仍然稳定启动、按需加载、统一对外。**

这就是当前阶段最重要的设计原则。
