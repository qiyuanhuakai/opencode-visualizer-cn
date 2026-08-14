# RoadMap 路线图
本文件记录项目的未来规划和待实现功能。
## [In Progress] 


- [ ] 完善text transformer
  - [ ] 添加多行支持
  - [ ] 不再劫持tab和空格
  - [ ] 添加{cursor}
  - [ ] 打通收藏和文本转换器
  - [ ] 支持更多前缀

- [x] chore：升级相关依赖，改善安全性和功能
- [x] 完善文件编辑器：快捷键支持、字体大小、本地应用打开与写回
- [x] 完善文本收藏功能，添加text transformer
- [x] 完善字体大小功能
    - [x] 给左侧边栏的文字（文件树，会话树，待办）接入字体大小调整功能 

- [x] 改善文件树体验
    - [x] 为不同后缀的文件采用不同图标
    - [x] 分支名不再过度压缩搜索框
    - [x] 搜索命中的文件夹完全展开

- [x] 改善插件兼容性
	- [x] omo：尝试识别Sisyphus Junior的类别（category）
	- [x] omo：特殊处理工具lsp-*、codegraph-*
    - [x] magic context：特殊处理子代理magic-context-*
    - [x] magic context：特殊处理工具ctx-*

- [ ] 修复已知问题
    - [?] codex：edit工具悬浮窗在首次弹出时不显示内容
    - [ ] opencode：改善idel/busy切换：当主代理等待子代理时，opencode似乎发送idel，但此时子代理仍在工作，不应该切到idel 
    - [ ] opencode：同步会话加载阻塞其他操作（包括操作设置，会话管理，拖动窗口），直到会话加载完成
    - [ ] all：长历史会话加载过于缓慢，但会话懒加载又导致滚动查看历史不顺畅（因为卡片的高度在未加载时未知，懒加载时滚动会导致加载跳动）。很难确认合理的方案。考虑懒加载线程历史和子代理？
    - [ ] all/filetree：调查“自动换行”开关对文件树上的文件失效的问题
    - [ ] “暂存区”似乎始终不显示内容，即使我有stash
    - [ ] 流式加载的thinking/output markdown的加载速度似乎远远慢于输入速度，导致还在流式加载就触发了输出结束的从头滚动
    - [ ] 会话树pin状态的恢复似乎因懒加载而产生问题：会恢复出空的不包含第三层级（会话）的第二层级（分支）（这个第三层级原本是pinned状态）；会丢失第三层级

- [ ] vis-bridge 模块化本地桥接服务器：集成外部开发工具，扩展与第三方工具的联动能力。
	- [x] ACP v1 通用后端（Pi、Oh My Pi、Kimi Code；通过状态监控按需启用）
		- [?] kimicode cli
	    - [?] oh-my-pi
	    - [?] pi
    - [ ] astrcodey web
    - [ ] kimi web
	- [ ] [opencode-magic-context](https://github.com/cortexkit/opencode-magic-context)
	- [ ] [gnhf](https://github.com/kunchenguid/gnhf)
	- [ ] [tokscale](https://github.com/junhoyeo/tokscale)
	- [ ] [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker)

## [Paused for difficulties]
- [ ] 添加内置浏览器：基于floatingwindow显示+内嵌webview，实现在visui上连接开发服务器/访问网页
- [ ] 添加语音输入功能：实现语音输入和文字转写
> 如需查看详细的版本变更记录，请参阅 [CHANGELOG.md](./CHANGELOG.md)。