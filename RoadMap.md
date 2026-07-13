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

- [ ] forgecode panel 迭代与修复
    - [ ] 设置里增加panel按钮的开关（类似codex panel）
    - [ ] 按钮位置移到管理模式的右侧；将codex panel的按钮移到forge panel的右侧
    - [ ] 修复pty终端的光标位置跟随不够智能的问题，现在经常出现光标在下方但滚动条滚不过去，或者光标在上方但是滚动条滚到底部的问题
    - [ ] 侧边栏支持伸缩和隐藏，删除会话按钮，让侧边栏本身支持:new :clone :conversation :conversation-rename :conversation-tree :delete
    - [ ] 输入框放到底部。输入框增加agent/功能选择器：forge muse sage suggest commit-preview
    - [ ] 增加config控制按钮和子菜单，支持:config :config-edit :config-model :config-reload :config-commit-model :config-suggest-model :config-reasoning-effort
    - [ ] 增加临时设置控制按钮和子菜单，支持:login :logout :model :reasoning-effort
    - [ ] 增加状态显示按钮和二级弹出悬浮窗，同时增加显示:info的model信息和:tools :skill :workspace-info
    - [ ] 增加工作区按钮和子菜单，支持:workspace-sync :workspace-init
    - [ ] 增加对话操作按钮和子菜单，支持:compact :copy :edit :retry


- [ ] vis-bridge 模块化本地桥接服务器：集成外部开发工具，扩展与第三方工具的联动能力。
	- [?] codex
	    - [ ] 实现会话级别diff
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
