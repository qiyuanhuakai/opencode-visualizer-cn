# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。

## [In Progress]

- [x] v0.9.0-alpha 统一运行环境（仅按验收证据勾选；证据目录 `.omo/evidence/vis-v090/`）

  - [x] `/runtime` v1 协议与 `v090-runtime` 协议代；一个 Bridge 入口按 target 路由，五类来源一次连接可浏览（task 43 全链路回归：18/18；独立门 APPROVE）
  - [x] 旧历史、草稿、收藏、辅助元数据完整迁移；迁移对旧来源只读、卸载保留数据（task 43 独立门：遍历前后每文件 SHA-256 不变；task 45 H10：卸载后 DB 字节完全一致 204,800B）
  - [x] 1 万会话/200 worktree/5 来源渐进可用，10 万 pins 压力档缓存有界（task 44：standard/stress/network100ms 三 profile 各 10 次运行、24 项阈值全过；100k pins 覆盖率 100%；计划规定的 200 worktree 与五类树形构成已播种并已评分（seed 090）；五 UI-TREE 渲染指标在 store-substrate 层级评分，App.vue 未接入）
  - [x] SSH 与 Slurm 真实执行（task 46：122 断言 0 跳过，真实 sshd/slurmctld/双 slurmd/munge/网络命名空间；compute 禁 SSH 与应用 TCP 下 1 CPU/128 MiB replacement relay 成功）
  - [x] 打包产物可安装可卸可更新（task 45：happy 115 断言、failure 35 断言；PATH 无 node 仍启动 store worker 与 PTY）
  - [x] 移除旧全局后端路由（`useBackend*` 接缝、`activeBackendKind` 全局单例、`getActiveBackendAdapter`/`getActiveBackendKind`/`setActiveBackendKind` 生产路径；task 48 完成，生产零消费，legacy 导出模块保留供测试沿袭）
  - [ ] 完成主界面接入统一运行时 wire（App.vue 接入；**未完成**，运行时客户端尚未成为生产传输）
  - [ ] Windows / macOS 安装包产物（**未构建也未声称**；RPM/NSIS/PKG 仅验证生成文本）
  - [ ] 真实 GitHub-release 更新下载+校验路径（未实测，只应用本地 deb）
  - [ ] macOS/Windows live 腿（只在 CI 工作流定义，未执行）

- [x] 修复已知问题

  - [x] opencode：撤销opencode会话后再发送一条消息，虽然会话已经被撤销，但是vis显示会恢复成未撤销状态
  - [x] opencode：经常触发在/上创建一个新会话的兜底策略，尽管有很多已有的会话
  - [x] codex：idel后，user发送一条新消息会导致上一条assistant消息消失（变为上上条assistant消息），刷新后恢复

- [x] 调查性能问题
  - [x] all：electron输入框输入延迟巨大，按键好一段时间才有反应（但是pnpm dev又好像没有问题）
  - [x] all：长期使用后，鼠标滚动存在延迟（但是拖动滚动条却没有延迟）
  - [x] all：怀疑文件树轮询导致长期问题。建议改为：每十分钟刷新一次
  - [x] codex：会话加载速度需要优化
  - [x] codex：偶现后端render超时

- [ ] 改善codex后端兼容性

- [ ] 改善kimi web后端兼容性

- [ ] 添加轻量级多账户额度显示器：在状态监控中汇总多个账户的 5 小时与周额度。



- [ ] vis-bridge 模块化本地桥接服务器：集成外部开发工具，扩展与第三方工具的联动能力。
  - [x] ACP v1 通用后端（Pi、Oh My Pi、Kimi Code；通过状态监控按需启用）
    - [?] kimicode cli
    - [?] oh-my-pi
    - [?] pi
    - [ ] minimax
    - [ ] dsh
  - [ ] dsh web
  - [ ] omo codex app-server
  - [ ] astrcodey web
  - [ ] [opencode-magic-context](https://github.com/cortexkit/opencode-magic-context)
  - [ ] [gnhf](https://github.com/kunchenguid/gnhf)
  - [ ] [tokscale](https://github.com/junhoyeo/tokscale)
  - [ ] [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker)

## [Paused for difficulties]

- [ ] 添加内置浏览器：基于floatingwindow显示+内嵌webview，实现在visui上连接开发服务器/访问网页
- [ ] 添加语音输入功能：实现语音输入和文字转写

> 如需查看详细的版本变更记录，请参阅 [CHANGELOG.md](./CHANGELOG.md)。
> v0.9.0-alpha 的协议破坏性变更、废弃登录路径、数据保留、Slurm 持久化条件与平台限制见 [docs/migration-v090.md](./docs/migration-v090.md)。
