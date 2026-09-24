# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。

## [In Progress]


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
  - [ ] 状态监控-token
  - [ ] 添加轻量级多账户额度显示器：在状态监控中汇总多个 Codex 账户的 5 小时（仅 Plus）与周额度。本轮仅记录计划，不实现。
  - [ ] 小修小补
- [ ] 改善kimi web后端兼容性




- [ ] vis-bridge 模块化本地桥接服务器：集成外部开发工具，扩展与第三方工具的联动能力。
  - [x] ACP v1 通用后端（Pi、Oh My Pi、Kimi Code；通过状态监控按需启用）
    - [?] kimicode cli
    - [?] oh-my-pi
    - [?] pi
    - [ ] minimax
    - [ ] dsh
    - [ ] cursor cli
  - [ ] omo codex app-server
  - [ ] dsh web
  - [ ] astrcodey web
  - [ ] [opencode-magic-context](https://github.com/cortexkit/opencode-magic-context)
  - [ ] [gnhf](https://github.com/kunchenguid/gnhf)
  - [ ] [tokscale](https://github.com/junhoyeo/tokscale)
  - [ ] [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker)

## [Paused for difficulties]

- [ ] 添加内置浏览器：基于floatingwindow显示+内嵌webview，实现在visui上连接开发服务器/访问网页
- [ ] 添加语音输入功能：实现语音输入和文字转写

> 如需查看详细的版本变更记录，请参阅 [CHANGELOG.md](./CHANGELOG.md)。
