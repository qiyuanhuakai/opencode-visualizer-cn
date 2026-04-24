# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。

## [In Progress] 

- [ ] 修改开屏页面的使用方法
- [ ] **修复已知问题**
	- [ ] "历史记录"功能不保存subagents的历史（需要把subagents的历史记录以标签的形式和主agent分开）
	- [ ] 通过"在编辑器中打开"修改文件后，已打开的悬浮窗中文件内容不会自动更新

## [Paused for difficulties]
- [ ] **完善“提供商与模型”** — 由于未知原因，目前无法从opencode server获取足够信息

- [ ] vis-bridge 模块化本地桥接服务器
	- [ ] 添加vis-bridge，一个读取本地设置和数据的轻量级服务器
	- [ ] 集成外部开发工具，扩展与第三方工具的联动能力。正在考虑：
		- [ ] **加入webui编辑器** — 考虑替换掉$EDITOR打开的方式	
		- [ ] [opencode-magic-context](https://github.com/cortexkit/opencode-magic-context)
		- [ ] [gnhf](https://github.com/kunchenguid/gnhf)
		- [ ] [tokscale](https://github.com/junhoyeo/tokscale)
		- [ ] [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker)
		- [ ] claudecode
		- [ ] codex
		- [ ] gemini cli
> 如需查看详细的版本变更记录，请参阅 [CHANGELOG.md](./CHANGELOG.md)。
