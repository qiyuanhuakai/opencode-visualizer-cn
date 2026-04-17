浮动窗口管理系统是可视化编辑器的核心交互框架，负责管理可拖拽、可调整大小的浮动内容面板。该系统采用三层架构分离：**窗口层**（FloatingWindow）处理几何属性与交互，**查看器层**（Viewers）负责内容模式选择，**渲染器层**（Renderers）执行具体内容的静态渲染。本系统由 `useFloatingWindows` 组合式函数统一协调，支持多种内容类型的动态注入与状态持久化。
## 核心架构设计
浮动窗口管理系统的架构遵循"外壳-内容"分离原则。`FloatingWindow.vue` 作为通用窗口外壳，提供拖拽手柄、调整大小手柄、标题栏和层级控制；实际内容通过动态组件 (`component :is="..."`) 注入，由 `entry.component` 决定渲染内容。App.vue 根据使用场景选择适当的 Viewer 组件，并通过 `fw.open()` 创建窗口实例。

```
FloatingWindow  (窗口层 — 拖拽、调整大小、z-index、标题栏)
└── component :is="..."  (查看器/渲染器层 — 内容展示)
```

该架构的关键优势在于**关注点分离**：窗口外壳不关心内容类型，内容组件不感知窗口管理逻辑，两者通过 props 接口解耦。每个窗口实例在 `useFloatingWindows` 中维护唯一键值，支持独立的状态更新与生命周期管理。
Sources: [docs/window-arch.md](docs/window-arch.md#L1-L23)

## 窗口层实现 (FloatingWindow.vue)
`FloatingWindow.vue` 实现通用的窗口外壳，支持以下核心功能：
- **拖拽交互**：通过标题栏触发，实时更新窗口位置
- **调整大小**：八方向调整手柄（四角 + 四边），支持自由缩放
- **层级管理**：点击激活时置顶（z-index 动态调整）
- **关闭操作**：标题栏关闭按钮触发销毁

组件接收 `entry` 对象作为核心配置，包含 `id`、`component`、`props`、`title`、`width`、`height`、`x`、`y` 等字段。窗口位置与尺寸状态通过 `useFloatingWindow` 局部管理，同时向全局 `useFloatingWindows` 注册更新回调，确保状态同步。
Sources: [app/components/FloatingWindow.vue](app/components/FloatingWindow.vue#L1-L50)

## 组合式函数：useFloatingWindows
`useFloatingWindows.ts` 提供全局窗口注册表与生命周期管理。核心数据结构为 `Map<string, FloatingWindowEntry>`，键值为窗口唯一标识。主要操作包括：
- `open(key, entry)`：创建新窗口或更新现有窗口配置
- `close(key)`：销毁指定窗口
- `updateOptions(key, options)`：增量更新窗口 props 或元数据
- `bringToFront(key)`：激活窗口（置顶显示）

该组合式函数维护窗口的创建顺序与焦点状态，确保激活窗口始终在最上层。同时处理窗口的持久化逻辑：当窗口内容通过 API 异步加载后（如文件读取），调用 `updateOptions` 更新 `entry.props` 而无需重建组件实例。
Sources: [app/composables/useFloatingWindows.ts](app/composables/useFloatingWindows.ts#L1-L100)

## 查看器层：ContentViewer 与 DiffViewer
查看器层根据内容类型选择适当的渲染器，并提供模式切换标签页。

**ContentViewer** 用于单文件显示（源代码、图像、二进制转储）。其模式选择逻辑基于内容特征：

| 条件 | 可用模式 | 默认 |
|------|---------|------|
| 提供 `imageSrc` | 图像、十六进制（如有 rawHtml） | 图像 |
| 二进制或图像扩展名 | 十六进制 | 十六进制 |
| Markdown 文件且有内容 | 渲染、源代码 | 渲染 |
| 其他文本文件 | 源代码 | 源代码 |

**DiffViewer** 用于 Git 差异、消息差异和提交差异。支持多文件标签页与主/子模式切换。主模式包括 Original（原始）、Modified（修改后）、Diff（差异视图）；当主模式为 Original 或 Modified 且文件为 Markdown 时，子模式 Rendered/Source 自动出现。

两个查看器均通过 `useCodeRender` composable 集成代码高亮逻辑，并发射 `rendered` 事件通知内容准备就绪。
Sources: [app/components/viewers/ContentViewer.vue](app/components/viewers/ContentViewer.vue#L1-L80), [app/components/viewers/DiffViewer.vue](app/components/viewers/DiffViewer.vue#L1-L120)

## 渲染器层：内容静态展示
渲染器是**原始、无状态**的展示组件，各自负责单一内容类型：

- **CodeRenderer**：语法高亮源代码，支持行范围高亮 (`lines` prop，如 `"5-10,20"`)，集成 `useCodeRender` 与 `CodeContent` 组件
- **DiffRenderer**：并排或统一差异视图，支持多文件标签页，通过 `useCodeRender` 的 `after`/`patch` 参数渲染
- **MarkdownRenderer**：通过 Web Worker (`renderWorkerHtml`) 使用 markdown-it + Shiki 渲染 HTML，支持预渲染 HTML (`html` prop) 跳过 worker，处理代码块复制按钮
- **ImageRenderer**：可缩放（滚轮）、可平移（拖拽）的图像查看器，双击重置视图
- **HexRenderer**：二进制转储显示，封装 `CodeContent` 并设置 `variant="binary"`

每个渲染器通过 `emits('rendered')` 通知父组件渲染完成，便于追踪加载状态。
Sources: [app/components/renderers/CodeRenderer.vue](app/components/renderers/CodeRenderer.vue#L1-L40), [app/components/renderers/DiffRenderer.vue](app/components/renderers/DiffRenderer.vue#L1-L30), [app/components/renderers/MarkdownRenderer.vue](app/components/renderers/MarkdownRenderer.vue#L1-L60), [app/components/renderers/ImageRenderer.vue](app/components/renderers/ImageRenderer.vue#L1-L35), [app/components/renderers/HexRenderer.vue](app/components/renderers/HexRenderer.vue#L1-L15)

## 应用集成点 (App.vue)
App.vue 通过事件处理器将用户操作映射到窗口创建：

**文件查看**：`openFileViewer(path, lines)` 从文件树或输出面板打开文件。流程为：`open-file` 事件 → `fw.open(key, { component: ContentViewer, props: { path, lang, ... } })` → API 异步获取内容 → `fw.updateOptions(key, { props: { fileContent, ... } })`。对于图像扩展名，额外传递 `imageSrc` (data URL) 以启用图像/十六进制切换。

**图像显示**：`handleOpenImage({ url, filename })` 处理消息附件或输入面板的图像，直接创建 `ContentViewer` 并传入 `imageSrc`、`imageAlt`。

**差异视图**：`openGitDiff`、`openAllGitDiff`、`handleShowMessageDiff`、`handleShowCommit` 从文件树或对话打开差异视图，统一使用 `DiffViewer` 并传入相应的 diff 数据 props。

所有调用均通过 `fw.open()` 注册窗口，后续通过 `fw.updateOptions()` 更新异步数据，确保窗口在数据到达前即可显示（可能显示加载状态）。
Sources: [app/App.vue](app/App.vue#L1-L50)

## 特殊查看器：MessageViewer
`MessageViewer.vue` 是对话消息的元查看器，封装 `MarkdownRenderer` 或 `CodeRenderer` 以处理用户输入、助手输出和工具窗口文本。其行为由 `allowModeToggle` 和 `lang` 控制：当 `lang="markdown"` 且允许切换时显示 Rendered/Source 标签页；`html` prop 强制使用 `MarkdownRenderer`（跳过 worker）；`code` + `lang` 通过 worker 渲染；`mode` 属性可强制指定渲染器。

MessageViewer 被多个组件复用：`ThreadBlock`、`ThreadHistoryContent`、`Welcome`、`ToolWindow/Question`、`ToolWindow/Subagent`、`ToolWindow/Reasoning`。
Sources: [app/components/MessageViewer.vue](app/components/MessageViewer.vue#L1-L45)

## 窗口生命周期与状态同步
浮动窗口生命周期由 `useFloatingWindows` 集中管理：
1. **创建**：`open(key, entry)` 生成窗口配置，若键不存在则创建新实例；若已存在则更新配置（热替换）
2. **更新**：`updateOptions(key, options)` 允许异步更新 props 或元数据而不销毁组件
3. **激活**：点击窗口自动置顶，维护 `activeKey` 状态
4. **销毁**：`close(key)` 移除注册表条目并销毁 Vue 组件实例

状态同步机制确保异步数据流（如文件读取、API 响应）能安全更新已打开窗口的内容。窗口配置（尺寸、位置）在组件内本地管理，但可通过扩展持久化到本地存储（当前实现未显式持久化，属于可扩展点）。
Sources: [app/composables/useFloatingWindows.ts](app/composables/useFloatingWindows.ts#L100-L150)

## 扩展性模式
系统设计支持多种扩展路径：
- **新内容类型**：新增 Renderer 组件并在相应 Viewer 的模式选择逻辑中注册
- **新查看器**：创建自定义 Viewer 包装多个 Renderer 并定义模式切换逻辑
- **窗口行为定制**：通过 `entry` 传递自定义 props 或事件处理器
- **持久化**：扩展 `useFloatingWindows` 在 `open/close` 时保存/恢复窗口布局到 `localStorage`

该架构的**核心模式**是"配置驱动渲染"：窗口行为完全由 `entry` 对象描述，使得动态创建与更新窗口成为纯数据操作，便于与后端状态同步或跨会话恢复。
Sources: [docs/window-arch.md](docs/window-arch.md#L24-L35), [app/composables/useFloatingWindows.ts](app/composables/useFloatingWindows.ts#L1-L30)

## 相关页面导航
- 下一步阅读：[渲染器与查看器架构](7-xuan-ran-qi-yu-cha-kan-qi-jia-gou) 了解内容渲染管线的详细设计
- 进阶主题：[全局状态管理与响应式设计](12-quan-ju-zhuang-tai-guan-li-yu-xiang-ying-shi-she-ji) 理解状态如何在整个应用中流动
- 参考文档：[窗口架构设计文档](29-chuang-kou-jia-gou-she-ji-wen-dang) 获取更底层的设计 rationale