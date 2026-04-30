Vis 的字体系统采用「双轨字体栈 + CSS 变量注入」的架构设计：终端（xterm）使用独立的等宽字体栈，应用内其余等宽文本（代码、消息、UI）共享另一套字体栈；两套栈均通过 CSS 自定义属性实时注入，配合 Local Font Access API 实现系统字体枚举与可用性检测。本文档面向中级开发者，解析字体配置的数据流、系统字体发现机制，以及各组件如何消费字体变量。

---

## 字体配置的数据模型与持久化

字体设置由 `useSettings` 组合式函数集中管理，暴露六个核心响应式状态：终端字体族 `terminalFontFamily`、应用等宽字体族 `appMonospaceFontFamily`，以及四个字号变量 `terminalFontSizePx`、`appFontSizePx`、`messageFontSizePx`、`uiFontSizePx`。每个状态均绑定 `watch` 监听器，在值变更时同步写入 `localStorage`（或 Electron 持久化存储），键名分别为 `settings.terminalFontFamily.v1`、`settings.appMonospaceFontFamily.v1` 等。同时，组合式函数监听跨标签页的 `storage` 事件，实现多窗口间的字体配置实时同步。

默认值经过精心编排：终端字体栈优先放置 Nerd Font（FiraCode Nerd Font Mono、CaskaydiaCove Nerd Font Mono 等），确保 Powerline 符号正确渲染；应用等宽字体栈以 SF Mono、JetBrains Mono 为首，兼顾 macOS 与跨平台体验。字号方面，终端默认 13px，代码视图与消息区域同为 13px，UI 控件为 12px。所有数值型设置均带有 clamp 边界（如终端字号 8–24px），防止用户输入极端值导致界面崩坏。

Sources: [useSettings.ts](app/composables/useSettings.ts#L32-L58), [useSettings.ts](app/composables/useSettings.ts#L199-L231), [storageKeys.ts](app/utils/storageKeys.ts#L53-L58)

---

## CSS 变量注入与组件消费

`App.vue` 作为字体变量的「根注入器」，通过 `syncAppMonospaceMetrics` 与 `syncCanvasTermMetrics` 两套函数，将当前字体配置写入 DOM。具体而言，`syncAppMonospaceMetrics` 同时向 `appEl`（应用根节点）和 `document.documentElement` 设置四个 CSS 变量：`--app-monospace-font-family`、`--app-monospace-font-size`、`--message-font-size`、`--ui-font-size`。终端相关变量 `--term-font-family` 与 `--term-font-size` 则注入到工具窗口画布（`toolWindowCanvasEl`）上，因为终端浮层需要独立的字体上下文。

下游组件通过 `var()` 引用这些变量，并始终提供 fallback 值以保证健壮性。例如 `ThreadHistoryContent.vue` 使用 `var(--message-font-size, 13px)` 渲染聊天消息，`CodeRenderer.vue` 与 `DiffRenderer.vue` 使用 `var(--app-monospace-font-size, 13px)` 渲染代码与差异内容，`SidePanel.vue`、`TopPanel.vue`、`Dropdown.vue` 等 UI 组件统一使用 `var(--ui-font-size, 12px)`。`FloatingWindow.vue` 更进一步，根据窗口类型（Shell 窗口 vs 普通浮层）动态选择 `--term-font-family` 或 `--app-monospace-font-family`，实现「同一组件、两种字体上下文」的切换。

Sources: [App.vue](app/App.vue#L3469-L3495), [App.vue](app/App.vue#L3458-L3467), [ThreadHistoryContent.vue](app/components/ThreadHistoryContent.vue#L336), [CodeRenderer.vue](app/components/renderers/CodeRenderer.vue#L451), [FloatingWindow.vue](app/components/FloatingWindow.vue#L159-L164)

---

## 系统字体发现：Local Font Access API

Vis 通过 `fontDiscovery.ts` 工具模块封装了浏览器 Local Font Access API，提供系统字体枚举、字体栈解析、可用性检测三大能力。`supportsLocalFontAccess()` 检测当前环境是否支持 `window.queryLocalFonts`；`loadLocalFontFamilies()` 异步调用该 API，将返回的原始字体记录按 `family` 分组聚合，生成包含 `fullNames`、`postscriptNames`、`styles` 的 `LocalFontFamily` 数组，并按字母顺序排序。

由于 Local Font Access API 需要用户授权，且部分浏览器（如 Firefox）尚未支持，模块同时实现了基于 Canvas 的字体可用性回退检测。`detectFontFamilyAvailability(family)` 使用「字符宽度对比法」：在 Canvas 2D 上下文中，先用通用回退字体（monospace、sans-serif、serif）测量基准文本 `mmmmmmmmmmlli00WQ@#` 的宽度，再用目标字体叠加同一回退字体进行测量；若宽度不同，则判定该字体可用。检测结果缓存于 `Map` 中，避免重复测量带来的性能开销。

字体栈解析器 `parseFontStack(stack)` 支持引号包裹的字体名（单引号或双引号）与裸名混合的复杂栈格式，返回去引号后的标准化数组。`prependFontFamilyToStack` 则用于将用户从系统字体列表中选中的字体插入栈首，并自动去重。

Sources: [fontDiscovery.ts](app/utils/fontDiscovery.ts#L1-L180)

---

## 设置面板中的字体交互

`SettingsModal.vue` 的「字体设置」页（`activePage === 'fonts'`）将上述能力整合为完整的用户交互流程。页面分为上下两大区块：上半部分配置终端字体（字体栈输入框 + 字号 + 预设芯片），下半部分配置应用等宽字体（同样结构，额外包含消息字号与 UI 字号）。

**预设芯片** 提供一键切换：终端字体预设包括 FiraCode Nerd、Caskaydia Nerd、Iosevka Term、JetBrains Mono；应用字体预设包括 SF Mono、JetBrains Mono、Fira Code、Iosevka Term。点击预设芯片即可将完整字体栈写入对应响应式状态。

**字体栈状态指示器** 位于输入框下方，实时展示当前栈中前 8 个字体族的可用性状态（`available` / `missing` / `generic`），通过 140ms 的 debounce 避免输入过程中频繁检测。状态以彩色标签呈现：绿色边框表示可用，红色边框表示未命中，灰色边框表示通用回退。

**系统字体探测面板** 通过折叠按钮展开。若浏览器支持 Local Font Access API，显示「扫描本地字体」按钮；点击后异步加载系统字体列表，以网格卡片形式展示（字体族名 + 样式列表）。用户点击任意卡片即可通过 `prependFamily` 将其插入对应字体栈首位。若 API 不可用，则显示提示文案，引导用户手动输入字体名并依赖状态指示器验证。

Sources: [SettingsModal.vue](app/components/SettingsModal.vue#L274-L530), [SettingsModal.vue](app/components/SettingsModal.vue#L785-L867), [SettingsModal.vue](app/components/SettingsModal.vue#L912-L925)

---

## 终端字体的特殊处理

终端字体不仅需要 CSS 变量注入，还需同步到 xterm.js 实例。`App.vue` 中的 `refreshOpenShellFonts` 函数在终端字体族或字号变更时被调用：首先通过 `waitForTerminalFontsReady` 使用 `document.fonts.load()` 预加载字体，确保字形就绪后再刷新所有已打开 Shell 会话的 xterm 配置（`fontFamily`、`fontSize`、`lineHeight`），并触发 `terminal.refresh()` 重绘。此外，`measureTerminalCellWidth` 通过创建不可见 DOM 探针测量字符平均宽度，用于计算终端窗口的精确像素尺寸（`getTerminalWindowSize`），保证 80×25 列行布局的物理尺寸准确。

Sources: [App.vue](app/App.vue#L3497-L3517), [App.vue](app/App.vue#L3418-L3434), [App.vue](app/App.vue#L3443-L3456)

---

## 字体变量的全局传播范围

下表汇总了各 CSS 变量的定义位置、主要消费者与用途：

| CSS 变量 | 定义位置 | 主要消费者 | 用途 |
|---|---|---|---|
| `--term-font-family` | `App.vue` canvas 注入 | `FloatingWindow.vue`（Shell 窗口）、`HexRenderer.vue`、`ArchiveRenderer.vue`、`ContentViewer.vue` | 终端及二进制/档案查看器的等宽字体 |
| `--term-font-size` | `App.vue` canvas 注入 | `FloatingWindow.vue`（Shell 窗口） | 终端浮层字号 |
| `--app-monospace-font-family` | `App.vue` 根节点 + `documentElement` | `InputPanel.vue`、`OutputPanel.vue`、`MarkdownRenderer.vue`、`SettingsModal.vue` 等 15+ 组件 | 应用全局等宽字体族 |
| `--app-monospace-font-size` | `App.vue` 根节点 + `documentElement` | `CodeRenderer.vue`、`DiffRenderer.vue`、`OutputPanel.vue` | 代码视图、差异查看器字号 |
| `--message-font-size` | `App.vue` 根节点 + `documentElement` | `ThreadHistoryContent.vue`、`ThreadBlock.vue` | 聊天消息与线程历史字号 |
| `--ui-font-size` | `App.vue` 根节点 + `documentElement` | `SidePanel.vue`、`TopPanel.vue`、`Dropdown.vue`、`InputPanel.vue` 等 | 侧边栏、顶部面板、下拉菜单字号 |

Sources: [tailwind.css](app/styles/tailwind.css#L5-L32), [App.vue](app/App.vue#L3472-L3494)

---

## 与相关模块的协作关系

字体系统与 Vis 的其他个性化模块紧密协作。字体设置页与主题设置页同属 `SettingsModal.vue` 的二级页面，用户可在同一弹窗内完成字体与主题的联合调整。字体变量 `--app-monospace-font-family` 同时被 Tailwind CSS v4 的 `@theme` 块引用为 `--font-sans`，确保 Tailwind 工具类与自定义样式的一致性。国际化层面，所有字体相关的标签、描述、状态文案均通过 `vue-i18n` 抽取到 `locales/zh-CN.ts` 等语言包中，支持简体中文、繁体中文、英文、日文、世界语五种语言。

如需进一步了解主题系统的实现细节，请参阅 [主题令牌与区域配色系统](21-zhu-ti-ling-pai-yu-qu-yu-pei-se-xi-tong)；如需了解设置面板的整体架构与持久化策略，请参阅 [存储键命名与持久化策略](28-cun-chu-jian-ming-ming-yu-chi-jiu-hua-ce-lue)。