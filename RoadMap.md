# RoadMap 路线图

本文件记录项目的未来规划和待实现功能。

## [In Progress]

- [x] 参考 Raycast Snippets 完善 Text Transformer
  - [x] 将数据结构从 `trigger/replacement` 演进为包含 `id`、`trigger`、`name`、`body`、`description?`、`enabled`、`tags?` 的 Snippet，并兼容迁移已有数据
  - [x] 候选框显示名称、描述和正文预览，不再直接展示完整 replacement；支持启用/禁用与按 tag 筛选
  - [x] 支持多行正文与多个触发前缀，不再劫持 Tab 和空格
  - [x] 支持 `{cursor}`，并首批加入 `{date}`、`{time}`、`{datetime}`、`{uuid}`、`{clipboard}`、`{activeFile}`、`{cwd}`、`{selection}` 动态变量
  - [x] 打通文本收藏与 Text Transformer，可将收藏内容直接创建为 Snippet
  - [x] 支持带版本号的 JSON 导入/导出（`{ "version": 1, "snippets": [...] }`），用于备份、恢复和跨设备迁移
  - [x] 当前版本不引入文件夹和脚本引擎；待 Snippet 数量与使用场景增长后再评估

- [x] 改善代码可维护性
  - [x] 参考fallow提供的探针修复高复杂度的代码
- [x] 改善内存占用问题
  - [x] 基于市面上常见的electron内存优化方案改善占用
  - [x] 改善将过多会话同时放入内存导致的内存占用问题
  - [x] 改善内存泄漏问题
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
  - [x] omo：特殊处理工具lsp-_、codegraph-_
  - [x] magic context：特殊处理子代理magic-context-*
  - [x] magic context：特殊处理工具ctx-*

- [ ] 修复已知问题
  - [?] codex：edit工具悬浮窗在首次弹出时不显示内容
  - [?] 流式加载的thinking/output markdown的加载速度似乎远远慢于输入速度，导致还在流式加载就触发了输出结束的从头滚动
  - [x] all/filetree：调查关闭“自动换行”时，横向滚动条不显示的问题
  - [x] 懒加载导致的后刷新有时候会导致切换到另一个session，疑似刷新早于当前session更新
  - [x] 懒加载导致加载完成后会有一次刷新，导致严重的闪屏，但是屏幕内容其实没啥变化
  - [x] 懒加载线程历史导致滚动困难：当到达懒加载边界时继续向上滚动的动画和速度都非常奇怪
  - [x] 新建的会话会持续显示加载中动画，尽管不知道有什么能加载的
  - [ ] 排查文件树自动刷新功能异常：能否在文件修改/git提交后自动刷新文件树
  - [ ] 调查opencode pty失效的问题

- [x] 提供electron的应用内检查更新和自动更新功能（包括vis_bridge的更新）。
- [x] 提供“最小化到托盘”的相关功能
- [x] i18n化并删减electron应用功能栏（file，edit，view，window）
- [x] 提供任务idle状态通知和通知音功能


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
