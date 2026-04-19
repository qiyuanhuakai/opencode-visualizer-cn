# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。


- [ ] **修复已知问题**
	- [x] 输入栏的层级太高，会覆盖悬浮窗（但是在需要向输入框输入文字的时候，又应该让它能覆盖悬浮窗）
	- "历史记录"功能不保存subagents的历史（需要把subagents的历史记录以标签的形式和主agent分开）
	- electron应用问题
		- [x] 自定义主题json上传无法持久化（包括在重新安装应用后消失，在启用第二个窗口后消失等等）
		- [x] 设置无法持久化，下个窗口以及重新安装还是从默认设置开始
		- [x] 默认连接的服务器地址无法持久化，修改链接地址后，下个窗口以及重新安装还是默认4096
	- [x] 很多模型无法attach文件，但是在opencode server上却可以，可能从opencode server获取的信息有错误，先直接改成允许所有模型attach文件好了
	- 通过“在编辑器中打开”修改文件后，已打开的悬浮窗中文件内容不会自动更新
	- [x] 悬浮窗的最小化和关闭按钮的样式似乎与字体有关，导致使用某些字体时很怪异
	- [x] "grep"工具的"模式"信息的字符的样式会受到主题影响
	- [ ] 开发功能electron:start报错
	- [ ] windows上某些界面行为和web端不一致
- [ ] **会话树支持** — 将现有的单会话级会话侧边栏改为基于项目-沙盒-会话的三层级会话树侧边栏	
- [ ] **更多语言支持** — 在简体中文基础上，增加繁体中文、日语等更多语言
- [ ] **外部工具支持** — 集成外部开发工具，扩展与第三方工具的联动能力。正在考虑：
	- [opencode-magic-context](https://github.com/cortexkit/opencode-magic-context)
	- [gnhf](https://github.com/kunchenguid/gnhf)
	- [tokscale](https://github.com/junhoyeo/tokscale)
	- [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker)
- [ ] **完善“提供商与模型”** — 由于未知原因，目前无法从opencode server获取足够信息
- [ ] **加入webui编辑器** — 考虑替换掉$EDITOR打开的方式


> 如需查看详细的版本变更记录，请参阅 [CHANGELOG.md](./CHANGELOG.md)。
