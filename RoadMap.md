# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。

## [In Progress]


- [x] 改善插件兼容性
  - [x] omo：尝试识别Sisyphus Junior的类别（category）
  - [x] omo：特殊处理工具lsp-_、codegraph-_
  - [x] magic context：特殊处理子代理magic-context-*
  - [x] magic context：特殊处理工具ctx-*

- [ ] 修复已知问题
  - [?] codex：edit工具悬浮窗在首次弹出时不显示内容



- [ ] vis-bridge 模块化本地桥接服务器：集成外部开发工具，扩展与第三方工具的联动能力。
  - [x] ACP v1 通用后端（Pi、Oh My Pi、Kimi Code；通过状态监控按需启用）
    - [?] kimicode cli
    - [?] oh-my-pi
    - [?] pi
  - [ ] astrcodey web
  - [ ] kimi web
  - [ ] [opencode-magic-context](https://github.com/cortexkit/opencode-magic-context)
  - [ ] [gnhf](https://github.com/kunchenguid/gnhf)
  - [ ] [tokscale](https://github.com/junhoyeo/tokscale)
  - [ ] [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker)

## [Paused for difficulties]

- [ ] 添加内置浏览器：基于floatingwindow显示+内嵌webview，实现在visui上连接开发服务器/访问网页
- [ ] 添加语音输入功能：实现语音输入和文字转写

> 如需查看详细的版本变更记录，请参阅 [CHANGELOG.md](./CHANGELOG.md)。