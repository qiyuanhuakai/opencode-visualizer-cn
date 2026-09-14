# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。

## [In Progress]


- [ ] 修复已知问题

- [ ] 改善codex后端兼容性
  - [ ] 状态监控-token
  - [ ] 小修小补

- [ ] 调查性能问题
  - [ ] 输入框输入延迟巨大，按键好一段时间才有反应
  - [ ] codex会话加载速度瓶颈
  - [ ] codex后端render超时



- [ ] vis-bridge 模块化本地桥接服务器：集成外部开发工具，扩展与第三方工具的联动能力。
  - [x] ACP v1 通用后端（Pi、Oh My Pi、Kimi Code；通过状态监控按需启用）
    - [?] kimicode cli
    - [?] oh-my-pi
    - [?] pi
    - [ ] minimax
    - [ ] dsh
    - [ ] cursor cli
  - [ ] omo codex app-server
  - [ ] kimi web
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