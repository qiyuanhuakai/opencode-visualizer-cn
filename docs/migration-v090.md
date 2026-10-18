# v0.9.0-alpha 迁移与发布兼容说明

本文档描述 v0.9.0-alpha 统一运行环境（Unified Runtime）相对于 v0.8.x 的**协议破坏性变更、废弃登录路径、数据保留承诺、旧 Bridge 拒绝规则、直连与管理浏览器差异、Slurm 持久化条件和不支持拓扑**，并给出完整的升级路径。

**本文所有结论均来自已落地的验收证据**，不是设计意图。每条关键声明后面标注了证据编号（E43、E44、E45、E46、E27 等），可在 `.omo/evidence/vis-v090/` 下对应目录核对。凡本文未标注证据的行为，即为未验证，不得据此声称支持。

**迁移状态：部分完成。** 旧全局后端路由（`useBackend*` 接缝与 `activeBackendKind` 全局单例，即 `getActiveBackendAdapter`/`getActiveBackendKind`/`setActiveBackendKind` 生产路径）已由 task 48 移除：生产动作不再经过全局 backend 路由，运行时消费者按连接作用域携带的 kind 显式解析 `getBackendAdapter(kind)`；被移除的全局函数仅保留在 legacy 导出模块（`app/backends/legacyGlobalRouting.ts`）供测试沿袭，无生产引用。`App.vue` 尚未接入新运行时 wire，本文描述的运行时能力已在存储、协议、驱动、远程与协作层真实验收，但主界面仍运行在 per-backend 适配器路径上，登录页按后端选择与每后端直连地址在本 alpha 仍存在且仍可使用，详见本文第 3 节。

---

## 1. 版本与协议代

| 项 | 值 | 证据 |
|---|---|---|
| 发布版本 | `0.9.0-alpha` | `package.json` |
| `/runtime` 协议版本 | `1`（`PROTOCOL_VERSION`） | `shared/runtime/protocol.js` |
| Bridge 协议代 | `v090-runtime`（`BRIDGE_PROTOCOL_GENERATION`） | `bridge/runtime/transports/remoteBootstrap.js:21` |
| 被拒绝的旧协议代 | `v070-legacy`（如 bridge `0.7.10`） | E27 |

---

## 2. 协议破坏性变更（breaking）

v0.9.0-alpha 引入 `/runtime` v1 协议。这是**新增通道**，不与 v0.8 的任何端点共用帧格式；旧版 Vis 客户端不认识它，新版客户端也只接受 `v090-runtime` 代的 Bridge。已验收的帧契约如下（E43）：

- **握手**：`hello{instanceId, capabilities}`，随后每帧携带 `version`、`target`、`epoch`、`generation`。
- **请求**：`request{id, method, target, params, idempotencyKey?}`；所有 mutation 必须带幂等键。
- **回应**：`result{id, ok, result|typedError}`；成功时 `phase` 三态分离：`read`（只读）、`durable-accepted`（意图已持久，尚未原生执行）、`native-executed`（原生已执行）。
- **事件**：`event{target, epoch, seq, entityRevision, scope, type, payload}`。
- **二进制通道**：独立 `binary channel{channelId, offset, length}`，不混入 JSON 帧。
- **固定错误码**：`invalid_request` / `unsupported` / `version_mismatch` / `unauthorized` / `conflict` / `cancelled` / `timeout` / `source_unavailable` / `reconcile_required` / `replay_required`。
- **固定限额**：最大 JSON 帧 1 MiB；二进制 chunk 64 KiB、每 channel 四个在途 credit；单目标活动 bulk channel 默认四个；UI WS 总 outbound 缓冲 8 MiB；snapshot token TTL 60s、最多三个在用；append/replay 日志上限 64 MiB 或 24h（先到者），被 trim 的旧 cursor 必须 `replay_required` 重建快照。

**对用户的影响**：直接以原始协议对接 Bridge 的第三方客户端必须按上述契约重写握手与错误处理；`durable-accepted` 与 `native-executed` 分离意味着"已接受"不等于"已执行"，重试必须依赖 `idempotencyKey`。

---

## 3. 废弃登录路径（仍可用于本 alpha）

以下路径标记为**废弃（deprecated）**，它们在本 alpha 仍然存在且经过既有回归保护，但不再作为推荐入口：

1. **登录页按后端选择**：登录界面先点选 OpenCode / Codex / ACP / Kimi Web / DSH 再连接的方式（`loginBackendKind` 全局选择）。新模型是"一次连接一个 Bridge 入口，按 target 路由"，不再依赖全局后端选择。
2. **每后端直连地址**：OpenCode `http://localhost:4096`、Codex `ws://localhost:23004/codex`、ACP `ws://localhost:23004`、Kimi Web `ws://localhost:23004/kimi-web/ws` 这类按后端分别填写的 URL。它们对 direct 连接仍然有效，但同一套地址在 managed remote 模式下改由管理端 `/runtime` 逻辑 WS 承载。
3. **`useBackend*` 接缝与 `activeBackendKind` 全局路由（task 48 已移除，列出以记录对比）**：`app/backends/registry.ts` 不再持有全局后端单例，只导出 `getBackendAdapter(kind)`，未注册 kind 直接抛错（fail-closed，无默认回退）；主界面组件（`ProjectPicker.vue`、`ProjectSettingsDialog.vue`、`ProviderManagerModal.vue`、`StatusMonitorModal.vue`）经连接作用域的显式 kind prop/param 解析适配器，不经过全局单例。被移除的 `getActiveBackendAdapter`/`getActiveBackendKind`/`setActiveBackendKind` 仅保留在 `app/backends/legacyGlobalRouting.ts` 供测试沿袭：仅 4 个测试文件引用、0 生产引用、构建产物 0 匹配。

**为什么仍可用**：全局后端路由的移除已由 task 48 完成（生产零消费，被移除函数仅保留在 legacy 导出模块供测试沿袭），但 `App.vue` 尚未接入新运行时 wire（见本文开头"迁移状态"与第 11 节）。因此主界面仍运行在 per-backend 适配器路径上，上述每后端选择与直连地址是本 alpha 主界面实际可用的连接方式；运行时能力通过共享层、驱动、Bridge 与组合式函数真实交付并有验收证据。

---

## 4. 数据保留承诺

- **不删除、不重置旧历史**：迁移对旧来源是**只读**的。E43 的独立门用真实 `legacyExport.js` 走完整遍历，遍历前后每个旧文件的 SHA-256 逐一比对不变（`localStorageSha256` 遍历前后均为 `cbd845c0…`，history 均为 `9b451f40…`），`exportRevision` 跨次打开稳定。
- **身份不明的数据保留为 unattached legacy namespace**：未绑定前不上传任意 remote target、不参与动作路由，由绑定界面显式处理。
- **卸载不删数据**：E45 的 H10 实测卸载整个安装目录后，DB 字节完全一致（204,800 B）、行计数一致、实体值逐字节一致，重装后可继续。
- **草稿不丢失指逐条持久副本**：草稿头、正文分块、附件 blob 分库存放，按 SessionKey 或未绑定 legacy context key 加 client-origin revision 寻址，不用时间戳盲目覆盖。

---

## 5. 旧 Bridge 版本拒绝

连接前即拒绝，不建立任何会话（E27）：

- 旧协议代主机（`protocol: 'v070-legacy'`、`bridgeVersion: '0.7.10'`）：`connectable=false`，`action='upgrade'`，`upgradePath.fromVersion='0.7.10'`，`requiredProtocol='v090-runtime'`；浏览器 `/healthz` 预连接探针在连接前即显示升级路径。
- 无 Bridge 主机：`action='install'`，`compatible=false`。
- 协议代匹配：`action='connect'`，`upgradePath=null`。

远程旧程序可在**同一 environmentId 上原地升级**：旧程序与 Runtime DB 先备份，再原子切换（E27 标准 3）。

---

## 6. 手动隧道与 direct / managed browser

| 模式 | 行为 | 证据 |
|---|---|---|
| direct | 前端直接访问目标 Bridge/服务；预建隧道可用 | E43、E27 |
| managed remote | 前端只持有管理端入口的一条 `/runtime` 逻辑 WS，SSH/Slurm 通道由管理端建立 | E46 |
| 手动隧道（预建） | 用户自建端口转发后按 direct 连接；loopback 健康 URL 会被主机身份判定为 remote | E27 |
| 纯浏览器无管理 Bridge | managed transport capability 显示 `unavailable`，direct/预建隧道仍可用 | 契约 11（计划固定契约） |

注意：不能凭 loopback URL 判断主机在本地。E27 实测"同一 loopback 健康 URL，SSH/Slurm 主机身份使其报告为 remote"，更新与安装判断以环境身份为准，不依赖 URL。

---

## 7. Slurm 持久化条件

持久化分三层，缺一层即不承诺对应语义（E46、Metis 闭环契约）：

1. **login-local control DB**：常驻 login 的控制角色 `vis_bridge --role=control-store` 在 login 本地持久磁盘持有 worker 数据库；compute Runtime 只执行 native/workspace/PTY，经 login-owned framed relay 请求持久化。
2. **compute-local socket/cache**：计算节点本地套接字与缓存，不跨作业生命周期承诺。
3. **原生 Harness state 与 workspace persistent data**：按各 driver 已验证版本的官方参数/env 设置 native state；不共享时不承诺节点消失后历史存在，提交前拒绝 durable mode。

**节点替换已验证**：E46 AC3 在 compute SSH 拒绝、应用 TCP 被 iptables 拦截、且一个 compute step 占满该节点全部预算（CPUAlloc=4/4、AllocMem=512/512、gres/gpu:2）的情况下，申请 1 CPU / 128 MiB / gres:0 的 replacement relay 仍然成功执行；store login 会话在饱和前、中、后逐字节一致。断线不取消作业，detach 不 cancel，stop 仅取消 owned job，borrowed allocation 不取消，到期/抢占不自动 replacement。

---

## 8. 不支持拓扑（明确 unsupported）

- **多节点作业**：本版本调度范围为单节点；多节点作业仅采用明确记录的 Bridge node，不默认跨节点。
- **`srun --parsable --async` 不作为兼容基线**。
- **缺 `--exact` / `gres=none` / reserve 支持**：明确 unsupported，不默认 overlap。
- **Slurm 自身网络/step I/O 不可用**：unsupported。
- **未取得平台证据不声称支持**：见下节。

---

## 9. 平台限制（逐字记录，不得改写为"支持"）

1. **没有构建、也没有声称任何 Windows 或 macOS 安装包产物**：RPM/Windows-NSIS/macOS-PKG 无法在本 Linux 主机上构建（`rpmbuild`、`makensis`、`pkgbuild` 均未安装），仅验证了各自生成的文本与布局（13/13 项）。E45 `notVerified` 逐条记录。
2. **没有走真实 GitHub-release 更新下载+校验路径**：更新腿只应用本地新构建的 deb（离线），更新 CLI 自身的守卫由其既有测试覆盖。
3. **Electron 运行时只在 Linux 实测**：Windows/macOS 运行时未执行。
4. **没有物理 GPU**：GRES 经 Slurm 真实 generic-GRES 记账演练（两个真实设备文件使 slurmd 真实报告 `gpu:2`），无真实 NVIDIA 设备。
5. **macOS/Windows live 腿只在 CI 工作流中定义、未执行**：它们消费 task 45 的真实打包产物，必须在 macOS/Windows GitHub runner 上运行。

---

## 10. 升级路径（backup → bind → import → verify → cutover）

按顺序执行，任何一步失败即停止，不回滚已保留的旧数据：

1. **backup（备份）**：备份旧来源全部持久键（localStorage 五键、SQLite/KV/settings、legacy JSON/history shard、IndexedDB 各 store）与当前 bridge 状态目录；记录每项 SHA-256。迁移不删源，备份用于回滚。
2. **bind（绑定）**：启动 v0.9.0-alpha bridge，确认 `/runtime` hello 的协议代为 `v090-runtime`；旧主机先完成升级（见第 5 节）。在绑定界面把旧来源逐项绑定到 target；身份不明的数据进入 unattached legacy namespace 等待显式绑定。
3. **import（导入）**：分批导入。每批先冻结本 client 旧写入口并记录 revision，批次 durable-ack 后再放行 pending 新格式写入；草稿逐条持久（头/正文分块/附件 blob 分库），导入计数与正文、附件 hash 全部核对后才继续。
4. **verify（校验）**：以只读方式复核导入结果：旧源 SHA-256 不变（与备份比对）、实体计数一致、草稿正文与附件 hash 与独立 oracle 一致、断线/重启/切换后 hash 稳定。E43 对同链路有等价验收。
5. **cutover（切换）**：校验全绿后切换客户端到新运行时入口；保留旧来源只读副本与回退路径，不删除源。未全绿不得 cutover。

---

## 11. 性能数字的实测配置（不得跨来源泛化）

本节数字来自 E44 的三个 profile，**每个都是 10 次独立运行的 nearest-rank p95**，测试配置为：

- 真实 headless Chromium（Playwright launchServer + connect，启用 `--enable-precise-memory-info` 与 `--js-flags=--expose-gc`），真实 IndexedDB（`vis-runtime-pins` / `vis-runtime-client`），**无 store mock、无内存替身**。
- 数据集：standard = 10,000 摘要 + 10,001 草稿；stress = 100,000 pins + 100,001 草稿；network100ms = 100 ms RTT / 20 Mbps 模拟。
- **数据集构成（实测报告自述）**：两档种子都**已播种并已评分**计划规定的树形构成（seed 090）：200 worktree、五类均分、1001+ Global roots、51+ Codex threads、等时间戳、archive/orphan/child；该构成播种在 harness 自有的 IndexedDB `vis-runtime-perf-tree`（stores worktrees + summaries）中，与 pin/草稿基质同在同一个真实 Chromium/IndexedDB 世界内，并按上述计划字面值逐维评分（观测值、独立推导与种子回执见各 profile 报告的 `dataset.worktrees` 块）。标识符仍按 `[profileId, environmentId, harnessInstanceId, nativeSessionId, clientOrigin]` 五元组写入 `vis-runtime-pins/identities`。
- RSS 定义为 **Vis 自有浏览器树的额外 RSS**（扣除空 renderer 基线后的 `/proc VmRSS`），不是独立 `vis_bridge` 进程 RSS（store 以 web worker 运行在 Chromium 树内）。
- **五个 UI-TREE 渲染指标（warm tree / cold cached topology / first selectable）在 store-substrate 层级评分，因为 `App.vue` 尚未接入运行时**；本文不声称任何运行中应用的渲染表现。

下表数字来自 task-44 的三个 profile 运行：standard 运行于 `2026-10-17T06:28:46.886Z`、stress 于 `2026-10-17T06:30:04.410Z`、network100ms 于 `2026-10-17T06:40:05.355Z`（报告副本存于本任务证据目录 `.omo/evidence/vis-v090/task-47/performance-reports/`，本文数字与副本逐格绑定）。task-44 的测量 lane 会周期性重跑，重跑后实时报告的数字可能与本表不同；比较时以本表注明的上述运行为准。

| 指标（阈值） | standard 10k 实测 | stress 100k 实测 | network100ms 实测 |
|---|---|---|---|
| warm tree ≤ 500 ms | 7 ms | 7.5 ms | 5.9 ms |
| cold cached topology ≤ 1000 ms | 8.4 ms | 7.9 ms | 7.2 ms |
| first selectable ≤ 2000 ms | 28.4 ms | 38.3 ms | 22.7 ms |
| selected-page ≤ 1000/2000 ms | 6.1 ms | 5.2 ms | 5.1 ms |
| index complete ≤ 60000/120000 ms | 791.1 ms | 5562.9 ms | 540 ms |
| interaction ≤ 100 ms | 0.7 ms | 0.6 ms | 0.5 ms |
| event-visible ≤ 200 ms | 25.6 ms | 27 ms | 23.6 ms |
| renderer heap ≤ 128/160 MiB | 1.63 MiB | 1.63 MiB | 1.63 MiB |
| 额外 RSS ≤ 256/512 MiB | 83.99 MiB | 171.68 MiB | 87.64 MiB |
| pins 覆盖率 = 100% | 10000/10000 | 100000/100000 | 100% |

上表**只对上述配置与数据集成立**，不得外推为"所有来源都达到该水平"；五类来源各自的协议与原生能力见 [docs/runtime.md](./runtime.md) 的实测矩阵。

---

## 12. 已知未决项

- 旧全局后端路由移除（task 48）已完成：`registry.ts` 只导出 `getBackendAdapter(kind)`（fail-closed），被移除的三个函数仅保留在 `app/backends/legacyGlobalRouting.ts` 供测试沿袭，生产零消费。仍未完成的是主界面接入统一运行时 wire（`App.vue` 接入，运行时客户端尚未成为生产传输），主界面因此仍走废弃登录路径（第 3 节）。
- macOS/Windows 安装包产物、真实 GitHub-release 更新、Windows/macOS Electron 运行、真实 GPU、macOS/Windows live 腿均未取得证据（第 9 节）。
- 已知非阻塞抖动：`app/runtimeGit.test.ts` 的 200-workspaces 用例与 `app/kimiWebWsProxy.boundaries.test.ts` 的 502 用例。
