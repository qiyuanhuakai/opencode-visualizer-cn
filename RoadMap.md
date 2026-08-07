# RoadMap 路线图
本文件记录项目的未来规划和待实现功能。
## [In Progress] 
- [ ] 添加内置浏览器：基于floatingwindow显示+内嵌webview，实现在webui上连接开发服务器
- [ ] 添加语音输入功能：实现语音输入和文字转写
- [ ] 完善文件编辑器：快捷键支持，字体大小
- [ ] 完善文本收藏功能，添加text transformer
- [ ] 修复已知问题
    - [?] codex：edit工具悬浮窗在首次弹出时不显示内容
    - [ ] acp：会话不显示左下角的持续时间
    - [ ] opencode：模型、提供商和状态监控概率被其他后端信息污染；目前状态监控-插件显示codex信息
    - [ ] all：子代理历史加载概率存在问题（不显示标题和历史信息），需要手动刷新页面才出现
    - [ ] all：子代理历史可能/或许会在子代理发送消息时才出现，而不是在子代理ses创建时就出现
    - [ ] all：会话状态更新失败：在同一会话中，无法从“思考中”正确回到idel/无法从idel切回“思考中”。但是切个新会话旧会话好像就可以回去
    - [ ] renderder：在超大文件(App.vue)中，行评论功能无法正常工作，滚动表现似乎与小文件不同
    - [ ] 在输入框中按上按键弹出的历史记录中存在大量assistant的消息。这里应当只包含user发送的内容
- [ ] vis-bridge 模块化本地桥接服务器：集成外部开发工具，扩展与第三方工具的联动能力。
    - [ ] 将vis_bridge的功能改为后台守护进程，改善服务启动失败报错表现
    - [ ] astrcodey
	- [x] ACP v1 通用后端（Pi、Oh My Pi、Kimi Code；通过状态监控按需启用）
		- [?] kimicode cli
	    - [?] oh-my-pi
	    - [?] pi
	- [ ] [opencode-magic-context](https://github.com/cortexkit/opencode-magic-context)
	- [ ] [gnhf](https://github.com/kunchenguid/gnhf)
	- [ ] [tokscale](https://github.com/junhoyeo/tokscale)
	- [ ] [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker)
    - [ ] codewhale
    - [ ] reasonix
## [Paused for difficulties]
> 如需查看详细的版本变更记录，请参阅 [CHANGELOG.md](./CHANGELOG.md)。