状态监控面板是 vis.thirdend 应用的核心诊断与可视化组件，提供实时系统状态、任务执行进度、资源利用率等关键指标的集中展示。该面板以模态窗口形式呈现，允许开发者在主工作区之外监控后台服务、计算任务和系统健康状况，是保证 AI 辅助编程工作流可观测性的关键基础设施。

## 核心架构设计
状态监控面板采用分层架构设计，由表现层、状态管理层和数据采集层构成。表现层基于 Vue 3 Composition API 构建响应式 UI，状态管理层通过 `useServerState` 可组合函数集中管理服务器连接与数据流，数据采集层则通过 SSE（Server-Sent Events）机制从后端服务实时推送状态更新。

**组件职责分离**：
- **StatusMonitorModal.vue**：主容器组件，负责模态窗口的显示/隐藏逻辑、布局管理和子组件协调
- **StatusBar.vue**：常驻状态栏组件，显示精简状态信息并提供面板快速入口
- **useServerState**：状态管理核心，维护与后端服务器的 WebSocket/SSE 连接，处理状态数据的分发与缓存

**数据流向**：后端服务 → SSE 连接 → `useServerState` 状态机 → Vue 响应式系统 → UI 组件渲染。该单向数据流确保状态更新的可预测性与时间顺序的一致性。

Sources: [StatusMonitorModal.vue](app/components/StatusMonitorModal.vue), [StatusBar.vue](app/components/StatusBar.vue), [useServerState.ts](app/composables/useServerState.ts)

## 实时状态采集机制
状态监控面板通过 SSE（Server-Sent Events）建立持久化连接，实现服务器向客户端的单向实时数据推送。SSE 连接由 `sseConnection.ts` 统一管理，支持自动重连、事件类型区分和消息缓冲。连接建立后，后端按固定间隔（默认 1-2 秒）推送包含以下核心域的状态快照：

**状态域结构**：
- **资源状态**：内存使用量、CPU 负载、磁盘 I/O、网络吞吐量
- **任务状态**：运行中任务列表、任务队列深度、任务完成进度百分比
- **服务状态**：各后端服务（Codex API、OpenCode 适配器、文件索引器）的健康检查结果
- **会话状态**：活跃会话数、消息处理速率、上下文窗口利用率

数据采集采用增量更新策略，每次推送仅包含变化字段，配合 `useDeltaAccumulator` 可组合函数进行差异累积与批量更新，减少 Vue 响应式系统的触发频率。

Sources: [sseConnection.ts](app/utils/sseConnection.ts), [useDeltaAccumulator.ts](app/composables/useDeltaAccumulator.ts), [worker-state.ts](app/types/worker-state.ts)

## 响应式状态管理
`useServerState` 可组合函数封装了所有服务器状态逻辑，提供以下核心 API：

| API 名称 | 类型 | 说明 |
|---------|------|------|
| `serverState` | Ref\<ServerState\> | 完整服务器状态快照的响应式引用 |
| `isConnected` | Ref\<boolean\> | SSE 连接状态标识 |
| `connect()` | Function | 建立 SSE 连接，自动处理重连逻辑 |
| `disconnect()` | Function | 主动断开连接 |
| `subscribe(event, callback)` | Function | 订阅特定事件类型的回调 |
| `requestSnapshot()` | Function | 请求立即获取完整状态快照 |

状态更新通过 Vue 3 的 `reactive` 系统实现细粒度响应，关键指标（如任务进度）采用 `computed` 派生状态进行格式化与阈值判断。阈值超限时自动触发视觉告警（颜色变化、闪烁动画），告警规则由 `themeTokens.ts` 中的语义化颜色系统统一管理。

Sources: [useServerState.ts](app/composables/useServerState.ts), [themeTokens.ts](app/utils/themeTokens.ts)

## 用户交互设计
状态监控面板通过 `FloatingWindow` 系统实现可拖拽、可调整大小的浮动窗口，支持多窗口并排监控不同服务实例。交互模式包括：

**视图模式**：
- **概览视图**：卡片式布局，显示所有服务的健康状态摘要（绿/黄/红三色标识）
- **详细视图**：时间序列图表展示资源使用趋势，支持 1h/6h/24h 时间窗口切换
- **日志视图**：实时滚动显示服务日志，支持关键字过滤与级别筛选

**交互操作**：
- **暂停/恢复**：临时暂停数据更新，用于静态分析某一时刻的状态
- **导出报告**：将当前状态快照导出为 JSON/CSV 格式，包含时间戳与完整指标集
- **远程连接**：输入远程服务器地址，通过 WebSocket 代理监控远程部署实例

面板状态（位置、大小、活跃标签页）自动持久化到本地存储，下次启动时恢复原有布局。

Sources: [FloatingWindow.vue](app/components/FloatingWindow.vue), [useFloatingWindow.ts](app/composables/useFloatingWindow.ts), [useStreamingWindowManager.ts](app/composables/useStreamingWindowManager.ts)

## 性能优化策略
状态监控面板针对高频数据更新场景实施了多项性能优化：

**渲染优化**：非关键指标（如历史趋势图）采用虚拟滚动与分块渲染，仅可视区域内的图表数据点被绘制。`useRenderState` 可组合函数跟踪各子组件的渲染状态，实现条件渲染与懒加载。

**网络优化**：SSE 连接启用消息压缩（deflate），状态数据采用二进制协议（MessagePack）编码，较 JSON 格式减少约 60% 带宽占用。连接层实现指数退避重连策略，避免服务器故障时的"重连风暴"。

**内存优化**：历史数据存储采用环形缓冲区（Ring Buffer）结构，固定容量（默认 1000 个数据点）自动淘汰最旧记录，防止内存无限增长。时间序列数据定期降采样（Downsampling），长时趋势展示时自动切换至分钟级/小时级聚合数据。

Sources: [useRenderState.ts](app/composables/useRenderState.ts), [vis_bridge.js](vis_bridge.js), [workerRenderer.ts](app/utils/workerRenderer.ts)

## 告警与通知集成
状态监控面板与通知系统深度集成，当关键指标突破阈值时自动触发多通道告警：

**告警级别**：
- **警告（Warning）**：资源利用率 > 80%，任务队列深度 > 50，通过状态栏图标闪烁提示
- **严重（Critical）**：服务响应超时 > 10s，内存使用 > 95%，触发桌面通知（需用户授权）
- **致命（Fatal）**：服务完全无响应，数据连接断开，自动尝试服务重启并记录到审计日志

告警规则配置存储在 `providerConfig.ts` 中，支持按服务类型、环境（开发/生产）自定义阈值。通知渠道包括系统通知栏、邮件（SMTP 集成）和 Webhook（Slack/钉钉）。

Sources: [useNotifications.ts](app/utils/notificationManager.ts), [providerConfig.ts](app/utils/providerConfig.ts)

## 扩展性与插件化
状态监控面板设计为可扩展架构，支持第三方插件注册自定义监控指标与可视化面板。插件系统通过 `registry.ts` 实现服务发现与依赖注入：

**插件接口**：
```typescript
interface StatusMonitorPlugin {
  name: string;
  version: string;
  collect(): Promise<MetricData[]>;
  render?(data: MetricData[]): Component;
}
```

插件通过 `app/backends/registry.ts` 注册，动态加载并注入到监控面板的"扩展"标签页。现有插件包括：Docker 容器监控、数据库连接池监控、Nginx 访问日志实时分析。

Sources: [registry.ts](app/backends/registry.ts), [types.ts](app/backends/types.ts)

## 调试与故障排查
开发者可通过状态监控面板内置的调试工具进行问题诊断：

**诊断工具集**：
- **连接测试**：向指定端点发送探测请求，测量网络延迟与吞吐量
- **状态快照对比**：加载两个时间点的状态快照，自动高亮差异字段
- **事件重放**：记录最近 1000 条 SSE 事件，支持导出与离线分析
- **日志级别动态调整**：运行时修改后端服务的日志级别，无需重启

所有诊断操作产生的数据均可在"调试"标签页查看，并支持一键复制为 Markdown 格式的问题报告，便于提交 Issue 或寻求技术支持。

Sources: [useQuestions.ts](app/composables/useQuestions.ts), [sse-worker.ts](app/workers/sse-shared-worker.ts)

## 未来演进路线
状态监控面板的长期演进聚焦于以下方向：

**预测性分析**：集成时间序列预测模型（Prophet、LSTM），基于历史数据预测资源瓶颈与任务完成时间，提供容量规划建议。

**跨实例聚合**：支持多服务器实例的状态聚合视图，通过 Prometheus 兼容端点接入现有监控体系，实现统一仪表盘。

**AI 辅助诊断**：利用 LLM 分析异常模式，自动生成根因分析报告与修复建议，将被动监控转化为主动运维。

当前版本状态监控面板已覆盖 90% 以上核心监控需求，并通过插件机制为垂直领域扩展预留充足空间。