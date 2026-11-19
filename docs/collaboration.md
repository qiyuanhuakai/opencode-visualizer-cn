# Host Thread 与协作

v0.9.0-alpha 的协作表面：一个 Host Thread 可加入多 Harness 并接力，原生会话绑定独立；任务、团队与隔离改动有明确归属与验收语义。本文只描述**已落地并有验收证据**的行为。

## 1. Host Thread

- Host Thread 保留独立 UUID；参与者引用 `SessionRef`（`{environmentId, harnessInstanceId, nativeSessionId}`）。**NativeSubagent 与 Host Participant 是不同实体**，不互相冒充。
- 一个 Thread 限于同一稳定环境/repository；跨环境上下文可只读引用，禁止把别的环境的 writer/patch 隐式纳入同一集成事务。
- 默认不替所有旧会话立即创建完整 Thread 对象；首次绑定采用 idempotent lazy wrapper，索引持 canonical binding，10k 历史不触发 10k 打开。
- E43 实测：一个 Host Thread 携带两个参与者跨两个 harness，真实 handoff 阶梯逐级走查 checkpoint。

## 2. 接力（handoff）

- handoff checkpoint 默认最多 32 KiB 文本 / 8000 估算 token（先到者），包含 goal/plan/decisions/diff/artifact/test/unresolved 摘要、hash 与按需证据引用。
- **不转发 API key 或环境机密，不复制完整 transcript**；tool/MCP 证据查询按 Thread、环境、参与者授权：证据引用列表不分页，证据字节页默认 4096 B、上限 65536 B（EVIDENCE_PAGE_BYTES / MAX_EVIDENCE_PAGE_BYTES）；timeline 条目页默认 100、上限 500（DEFAULT_TIMELINE_PAGE_LIMIT / MAX_TIMELINE_PAGE_LIMIT）。
- delivery 状态：`checkpoint → attached → prepared → delivered → observed → active`，native turn terminal 另计；打开/发送失败有 rollback/reconcile，不重复 ambiguous prompt。

## 3. 任务与尝试（Tasks / Attempts）

- 状态：`pending / dispatched / review / accepted / failed / cancelled / paused`。
- **task successful 必须 attempt 原生终态 + 验收/审查状态 accepted**。原生结束不等于 Host 接受；已发送或 Agent 自报完成不等于任务已验收。
- 默认四个活动 attempts、每原生 Session 单 mutation owner；Team DAG 检查环，依赖失败/取消有显式策略，子任务级联取消；role 不替代权限。
- Agent 侧 delegate/status/message/evidence 工具经动态只读/控制工具注入：优先 Harness 原生 MCP 支持；ACP 无工具注入时由 Host UI 执行 delegation，能力显示 UI-only，**不捏造 native delegate 能力**。
- participant mailbox 双向持久、按 scope 授权、大小 32 KiB；单任务默认最多 32 个子任务、深度 4、1000 条 mailbox 消息，超预算暂停并展示，不自动扩大并发或付费资源。
- E43 实测：一个 team task 被派发一次并 fan-out 到两个 harness，被审查的 artifact 被真实捕获。

## 4. 隔离改动与审查

- writer 默认独立 worktree，base commit 与 lease 持久；reviewer 使用原生只读策略，缺策略时用快照/隔离 worktree 并注明**不是安全沙箱**。
- 产物支持 binary/untracked，记录 common-dir/base/tree/blob hash 与 path 清单，size 预算 32 MiB（超限保留可下载 artifact 且拒绝自动集成）。
- 集成目标必须干净且 HEAD 匹配已审查 base；**显式用户批准 reviewed artifact hash 后**，在 Runtime 串行 integration lease 下检查 → apply → tests → durable record。
- 失败保留产物/worktree，不用 `reset --hard` / force push / 自动 stash；写入后测试失败恢复本操作自己创建的干净临时 integration worktree，不回滚用户目录；最终应用前重新比对 HEAD/clean 并由 Git 原子 ref 更新或受控 fast-forward 完成。普通 dirty 目录只能展示 patch 或用户清理后重试。无 Git 目录单 writer。

## 5. 与旧行为的差异

- 跨来源任务接力**不伪装为原生状态迁移**：接力产生 Host 因果事件，原生 transcript/config/credentials 仍由各 Harness 管理。
- 并行派发、团队任务、审查集成的界面与验收状态属于同一发布；波次只表示实施顺序。

## 6. 相关文档

- 运行时与协议：[runtime.md](./runtime.md)
- 远程执行：[remote.md](./remote.md)
- 升级路径：[migration-v090.md](./migration-v090.md)
