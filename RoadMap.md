# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。


- [ ] **修复已知问题**
	- 输入栏的层级太高，会覆盖悬浮窗
	- "历史记录"功能不保存subagents的历史
	- “历史记录”功能不保存工具调用信息
	- “差异”功能只显示差异，不显示before/after
	- 自定义主题无法持久化
	- 设置无法持久化，下个窗口还是从默认设置开始
	- 很多模型无法正确attach文件，因为从opencode server获取的信息有误
	
- [ ] **更多语言支持** — 在简体中文基础上，增加繁体中文、日语等更多语言
- [ ] **外部工具支持** — 集成外部开发工具，扩展与第三方工具的联动能力。正在考虑：
	- [opencode-magic-context](https://github.com/cortexkit/opencode-magic-context)
	- [gnhf](https://github.com/kunchenguid/gnhf)
	- [tokscale](https://github.com/junhoyeo/tokscale)
	- [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker)
- [ ] **完善“提供商与模型”** — 由于未知原因，目前无法从opencode server获取足够信息
- [ ] **加入webui编辑器** — 考虑替换掉$EDITOR打开的方式


> 如需查看详细的版本变更记录，请参阅 [CHANGELOG.md](./CHANGELOG.md)。
