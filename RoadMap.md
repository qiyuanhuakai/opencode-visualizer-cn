# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。

## [In Progress] 

- [ ] 修复已知问题
	- [ ] "历史记录"功能中subagent的历史和主agnet混在一起
	- [ ] “文件树”中的文件夹有概率在第一次打开时不显示文件，需要开关一次才会显示文件
	- [ ] “文件树”中文件级别的diff刷新有很大的延迟(git级别的diff刷新延迟不大)
	- [ ] “文件树”有小概率只显示前五个文件，需要刷新网页后才会恢复(刷新文件树不恢复)
	- [ ] “输出面板”加载超大会话时，会有从上向下的滚动和试图维持在最新会话，但似乎有什么向上的力量导致的跳动，不能稳定在最新那条对话
	- [ ] “输出面板”无法正确加载登录进来以后的第一个会话，必须手动刷新一次

- [ ] vis-bridge 模块化本地桥接服务器
	- [ ] 集成外部开发工具，扩展与第三方工具的联动能力。正在考虑：
		- [?] codex
		- [ ] 加入webui编辑器：考虑替换掉$EDITOR打开的方式	
		- [ ] [opencode-magic-context](https://github.com/cortexkit/opencode-magic-context)
		- [ ] [gnhf](https://github.com/kunchenguid/gnhf)
		- [ ] [tokscale](https://github.com/junhoyeo/tokscale)
		- [ ] [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker)
		- [ ] oh-my-pi
		- [ ] gemini cli
		- [ ] kimicode cli

## [Paused for difficulties]

> 如需查看详细的版本变更记录，请参阅 [CHANGELOG.md](./CHANGELOG.md)。



