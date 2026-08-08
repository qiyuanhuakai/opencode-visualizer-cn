# RoadMap 路线图
本文件记录项目的未来规划和待实现功能。
## [In Progress] 
- [ ] 添加内置浏览器：基于floatingwindow显示+内嵌webview，实现在webui上连接开发服务器
- [ ] 添加语音输入功能：实现语音输入和文字转写
- [ ] 完善文件编辑器：快捷键支持，字体大小
- [ ] 完善文本收藏功能，添加text transformer
- [ ] 改善文件树体验
    - [ ] 为不同后缀的文件采用不同图标
    - [ ] 分支名不再过度压缩搜索框
    - [ ] 搜索命中的文件夹完全展开 
- [ ] 改善插件兼容性
	- [ ] omo：尝试识别Sisyphus Junior的类别（category）
	- [ ] omo：特殊处理工具lsp-*
    - [ ] magic context：特殊处理子代理magic-context-compartment
    - [ ] magic context：特殊处理工具ctx-*
- [ ] 修复已知问题
    - [?] codex：edit工具悬浮窗在首次弹出时不显示内容
    - [ ] opencode：改善idel/busy切换：当主代理等待子代理时，opencode似乎发送idel，但此时子代理仍在工作，不应该切到idel 
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
