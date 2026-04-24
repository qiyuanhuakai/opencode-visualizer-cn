# 变更日志 Changelog

本文档记录本 fork 项目相对于上游 [xenodrive/vis](https://github.com/xenodrive/vis) 的所有功能改进、性能优化和修复。

---
## [v0.3.0 released]

### 悬浮窗管理

- [x] 悬浮窗支持预览.ico文件的图片
- [x] 悬浮窗支持预览可执行二进制文件和损坏的二进制文件的信息和hexdump
- [x] 悬浮窗支持高亮生物信息学相关文件：
	- FASTA (.fasta, .fa, .fna, .faa)
	- FASTQ (.fastq, .fq)
	- SAM (.sam)
	- VCF (.vcf) 
	- BED (.bed)
	- GTF/GFF (.gtf, .gff, .gtf3)
- [x] 为悬浮窗hexdump预览增加虚拟滚动功能，降低性能开销
- [x] 为Shiki语法高亮补全了大量可高亮的语言

**新增语言映射**:
| 扩展名 | Shiki语言ID |
|--------|-------------|
| `.cjs`, `.mjs` | `javascript` |
| `.svelte` | `svelte` |
| `.astro` | `astro` |
| `.json5`, `.jsonc` | `json` |
| `.mdc`, `.mdx` | `markdown` |
| `.htm` | `html` |
| `.sass` | `sass` |
| `.less` | `less` |
| `.bash`, `.zsh` | `shellscript` |
| `.pyw` | `python` |
| `.h`, `.hpp`, `.hh` | `cpp` |
| `.cs` | `csharp` |
| `.erb` | `ruby` |
| `.pl`, `.pm` | `perl` |
| `.lua` | `lua` |
| `.dockerfile` | `dockerfile` |
| `.mk`, `.mak` | `makefile` |
| `.gql`, `.graphql` | `graphql` |
| `.regex`, `.regexp` | `regex` |
| `.coffee`, `.coffeescript` | `coffee` |
| `.r` | `r` |
| `.jl` | `julia` |
| `.wasm` | `wasm` |
| `.wgsl` | `wgsl` |
| `Makefile` | `makefile` |
| `Dockerfile` | `dockerfile` |

### 主题设置（Beta）

- [x] 支持自定义不同功能的悬浮窗颜色和透明度
- [x] 支持自定义shell（xterm.js）背景颜色和透明度
- [x] 扩展schema语义以支持上述的自定义功能

### 编辑器集成

- [x] 支持了在关闭$EDITOR对应的shell窗口后，悬浮窗预览内容自动刷新

### Bug 修复

- [x] 修复了空心圆点在linux平台上和其他平台渲染效果不一致的问题
- [x] 修复了diff界面可能存在信息为全空的项的问题
- [x] 修复了electron开发在windows上报错的问题
- [x] 修复了electron打包应用中“复制”按钮失效的问题
- [x] 修复了被删除的文件在刷新后仍然显示在文件树中的问题

### 上游问题

- [x] 已经验证数项上游问题，这些预览在Vis前端已经支持，但无法实际使用
	- [x] OpenCode serve 的/file/content api对pdf文件返回空的二进制，导致无法预览
	- [x] OpenCode serve 的/file/content api对压缩文件返回空的二进制，导致无法预览
	- [x] OpenCode serve 的/file/content api会将icns文件以plain text形式返回，损坏原始信息，导致无法预览

## [v0.2.0 released]

### 国际化 (i18n)

- [x] 添加繁体中文（台湾用语）翻译，覆盖全部界面文本
- [x] 添加日语翻译，覆盖全部界面文本
- [x] 添加世界语（Esperanto）翻译，覆盖全部界面文本

### 字体管理（Beta）

- [x] 允许设置终端字体大小、代码视图字体大小、消息字体大小、界面字体大小

### 状态监控

- [x] 实时显示当前会话的 Token 使用情况，包括模型上下文限制、输入/输出/推理 Token 数量、缓存命中、使用率百分比进度条
- [x] 状态监控面板支持横向滚动，解决按钮过多导致的布局溢出

### 悬浮窗管理

- [x] 支持在设置中开启/关闭悬浮窗预览自动换行，防止长行代码影响阅读（适用于文件预览、edit/write/patch、git diff 等所有带行号的悬浮窗）

### 会话管理增强

- [x] 将现有的单会话级会话侧边栏改为基于项目-沙盒-会话的三层级会话树侧边栏(beta)
- [x] 修改了顶部会话栏的样式，使其与其他位置风格统一
- [x] 实现重命名会话功能

### 标识设计

- [x] 为electron应用打包提供icon

### 主题设置（Beta）

- [x] 全面弃用window.prompt和window.confirm，改用自定义控件以适配主题


### Bug 修复

- [x] 修复 `grep` 工具"模式"信息的字符样式被主题错误覆盖的问题
- [x] 修复对话级别"差异"只显示 diff、不显示 before/after 的问题
- [x] 修复 `/` 快捷命令下拉列表被限制为仅显示 8 条内容的问题，现在显示全部匹配命令
- [x] 修复 `@` 快捷命令在选择代理后会再次触发弹窗的问题
- [x] 修复所有输入框在用户输入过程中应用上下限限制，导致输入过程被截断的问题
- [x] 修复后台hydration过慢的问题，改善加载速度
- [x] 修复顶部栏每个sandbox只能显示五条session的问题
- [x] 修复顶部栏的标题有可能会换行的问题


## [v0.1.0 released]

### 国际化 (i18n)

- [x] 完整 i18n 框架支持
- [x] 添加简体中文翻译，覆盖全部界面文本

### 字体管理（Beta）

- [x] 允许设置 Shell 终端字体
- [x] 允许设置界面等宽字体
- [x] 实现系统字体自动发现功能（依赖浏览器 API）
- [x] 实现字体命中情况确认功能

### 供应商与模型管理（Beta）

- [x] 允许查看现有和全部供应商列表
- [x] 允许查看、启用、禁用现有模型（仅限本地，无法同步到服务端）

### 状态监控

- [x] 允许查看服务器状态
- [x] 允许查看 MCP 服务器状态
- [x] 允许查看 LSP 状态
- [x] 允许查看 Plugin 状态
- [x] 允许查看 Skills 状态
- [x] 允许关闭 MCP 服务器连接

### 主题设置（Beta）

- [x] 支持自定义每一块卡片的不同区域和不同组件的颜色
- [x] 支持导入自定义主题
- [x] 支持自定义主题格式schema

### 编辑器集成

- [x] 添加"用编辑器打开"功能，允许使用系统的 `$EDITOR` 环境变量打开文本文件

### 代码行评论

- [x] 添加"代码行评论"功能
- [x] 支持鼠标拖拽选择代码范围
- [x] 支持将评论内容附加到输入框

### 会话管理增强

- [x] 添加 Session Pin 功能，在侧栏增加 Sessions 面板
- [x] 允许将常用 Session Pin 在侧边栏快速访问
- [x] 添加批量管理功能，在顶栏增加 Management 按钮
- [x] 支持多选 Session 进行批量操作
- [x] 添加取消归档功能，允许找回已归档的 Session

### 悬浮窗管理

- [x] 为所有悬浮窗添加关闭和最小化按钮
- [x] 允许手动隐藏和最小化所有悬浮窗
- [x] 支持关闭自动最小化功能
- [x] 添加底部 Dock 栏，用于存放最小化后的悬浮窗

### 快捷命令

- [x] 添加对 `@` 快捷命令的支持，用于显式召唤代理

### 性能优化

- [x] 对超大 Session 列表实现懒加载 (Lazy Loading)，显著降低卡顿
- [x] 对超多 Session 实现后台 Hydration，加快冷启动速度
- [x] 清理冗余代码，减少包体积

### 桌面应用

- [x] 支持将 Web UI 打包为跨平台桌面应用（Windows / macOS / Linux）
- [x] 基于 Electron 框架，支持独立应用窗口、安全沙箱与系统浏览器外链跳转
- [x] 开发模式自动检测 `127.0.0.1:5173` 并拉起 Vite 预览服务
- [x] 桌面端持久化存储通过主进程写入 `renderer-storage.json`，解决自定义主题、设置、服务器地址在重新安装或多窗口场景下丢失的问题

### 基础设施

- [x] 修改默认端口为 `23003`，减少在 WSL 上与 Windows 服务的端口冲突
- [x] Vite 开发服务器固定绑定 `127.0.0.1:5173`（`strictPort: true`），避免 `localhost` 解析到 `::1` 导致 Electron 连接失败

### Bug 修复

- [x] 修复输入栏层级过高覆盖悬浮窗的问题
- [x] 修复 Windows 上部分界面行为与 Web 端不一致的问题
- [x] 修复多数模型无法 attach 文件的问题（改为默认允许所有模型 attach）
- [x] 修复悬浮窗最小化和关闭按钮样式受字体影响而显示异常的问题





---

## 上游原始功能

以下功能由上游 [xenodrive/vis](https://github.com/xenodrive/vis) 提供，本 fork 完整保留：

- 以审阅为核心的悬浮窗口，保持工具输出和智能体推理的上下文
- 支持多项目和工作树的会话管理
- 内置语法高亮的代码和 diff 查看器
- 交互式智能体工作流的权限和问题提示
- 基于 xterm.js 的嵌入式终端

---

> 🗺️ **路线图与未来计划**：请参阅 [RoadMap.md](./RoadMap.md)
