# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。

## [In Progress] 

- [ ] 添加内置浏览器：基于floatingwindow显示+内嵌webview，实现在webui上连接开发服务器
- [ ] 添加语音输入功能：实现语音输入和文字转写
- [ ] 完善文件编辑器：快捷键支持，字体大小
- [ ] 修复已知问题
    - [ ] "历史记录"功能中subagent的历史和主agnet混在一起
    - [ ] codex: pin/unpin逻辑混乱
    - [ ] codex: 服务器连接缓慢
    - [ ] codex：模型名称只在当前tune的第一个操作显示，后面就都不显示了
    - [ ] codex：之前的会话的创建/活跃时间会跟随最新会话的时间刷新
    - [ ] codex：会话不显示左下角的持续时间
    - [ ] codex：edit工具悬浮窗不显示内容
    - [ ] codex：websearch webfetch工具悬浮窗会把页面上的“复制 已复制”包括进去、
    - [ ] codex: 状态监控-mcp始终显示mcp是禁用状态，但其实mcp已经启用
    - [ ] codex：所有会话前面的标识都是绿色实心圆的“空闲”，而不是和opencode一样，在未被触发时显示灰色空心圆
    - [ ] codex：刷新页面时，会进入一个在"/"下创建的新会话，而不是原来的会话
    - [ ] codex: 路径"/"下的文件树明明能加载出来，但却显示“文件树加载失败”
    - [ ] codex：toppanel现在会显示有归档会话但没有显示会话的沙盒/global文件夹

	
- [ ] vis-bridge 模块化本地桥接服务器：集成外部开发工具，扩展与第三方工具的联动能力。
	- [?] codex
	    - [ ] 实现会话级别diff
	    - [ ] 完善状态监控面板（由于我不经常使用codex，只能确保其基本可用）
	    	- [ ] 适配“插件”相关功能
        - [ ] 支持codex特有的“$”快捷命令，用于调用skills
    - [ ] deepseek-tui
    - [ ] reasonix
	- [ ] kimicode cli
	- [ ] oh-my-pi
    - [ ] astrcodey
	- [ ] [opencode-magic-context](https://github.com/cortexkit/opencode-magic-context)
	- [ ] [gnhf](https://github.com/kunchenguid/gnhf)
	- [ ] [tokscale](https://github.com/junhoyeo/tokscale)
	- [ ] [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker)
	- [ ] gemini cli

## [Paused for difficulties]

> 如需查看详细的版本变更记录，请参阅 [CHANGELOG.md](./CHANGELOG.md)。
