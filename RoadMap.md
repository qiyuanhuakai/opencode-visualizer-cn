# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。

## [In Progress] 

- [ ] 修复已知问题
	- [ ] "历史记录"功能中subagent的历史和主agnet混在一起
	- [ ] “输出面板”加载超大会话时，会有从上向下的滚动和试图维持在最新会话，但似乎有什么向上的力量导致的跳动，不能稳定在最新那条对话
	- [ ] “输出面板”无法正确加载登录进来以后的第一个会话，必须手动刷新一次
	- [ ] 我对“输出面板”的期望：
		- [ ] 会话显示出来时，稳稳地停在最新对话
		- [ ] 向上滚动时，不会因为懒加载让人无法准确定位历史内容（不能一边向上滚动上面一边在改变高度） 
		- [ ] 在以上两点都实现的情况下，尽可能优化性能
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



