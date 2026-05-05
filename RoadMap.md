# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。

## [In Progress] 

- [ ] 修复已知问题
	- [ ] "历史记录"功能中subagent的历史和主agnet混在一起
- [ ] vis-bridge 模块化本地桥接服务器：集成外部开发工具，扩展与第三方工具的联动能力。
	- [?] codex
		- [ ] 完善“会话树”相关功能，包括
			- [ ] 全面模拟opencode后端的会话树表现
			- [ ] 将“取消订阅”“隐藏”“归档”改为更符合直觉的按钮
		- [ ] 完善“输出面板”，包括
			- [ ] 完善“历史记录”，现在还不能正确记录会话历史和工具调用
			- [ ] 完善动效状态，现在发送消息会出现显示异常
			- [ ] 探索实现会话级别diff的可能性？
		- [ ] 完善“提供商与模型”，支持codex cli的byok功能
		- [ ] 完善快捷命令，支持完整的“/”命令
		- [ ] 完善状态监控面板？
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



