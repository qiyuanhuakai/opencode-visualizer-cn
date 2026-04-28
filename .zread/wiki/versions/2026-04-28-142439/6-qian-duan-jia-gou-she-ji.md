本文档深入分析 OpenCode Visualizer 的前端工程架构，涵盖技术栈选型、模块组织模式、构建配置以及核心设计决策。基于代码考古方法，所有结论均可通过仓库中的具体文件路径验证。

## 技术栈核心架构

项目采用 **Vue 3 + TypeScript + Vite** 作为前端核心栈，配合 Electron 实现桌面端封装。这一选择通过 `package.json` 中的依赖声明得到确认，其中 `vue` 版本为 `^3.5.28`，`vite` 版本为 `^7.3.1`，`typescript` 版本为 `^6.0.3`。构建工具 Vite 在 `vite.config.ts` 中配置了自定义的根目录设置 (`root: 'app'`) 和输出目录 (`outDir: '../dist'`)，表明项目采用 **monorepo 风格**的单仓库多包结构，前端资源与后端脚本分离部署。

### 关键技术决策验证

- **Node.js 模块系统**：`package.json` 中 `"type": "module"` 声明使用 ES Module，所有 `.ts` 和 `.js` 文件均以模块化方式编写，避免 CommonJS 与 ESM 混用导致的兼容性问题。
- **运行时 Polyfill**：`vite.config.ts` 中的 `resolve.alias` 配置将 `buffer`、`fs`、`path`、`crypto` 等 Node.js 核心模块重定向到 `app/utils/node-polyfill.ts`，确保在浏览器环境中调用 Node API 时不会报错，这是 Electron 应用常见的桥接策略。
- **代码分割策略**：Vite 构建配置中的 `manualChunks` 函数明确将第三方依赖按功能分组：`vendor-vue`（Vue 核心）、`vendor-vue-i18n`（国际化）、`vendor-ui`（UI 组件库）、`vendor-terminal`（终端组件 @xterm）、`vendor-utils`（工具库如 marked、date-fns、lodash）。这种分组策略减少了首屏加载体积，同时避免了 Vue 核心库被错误拆分到多个 chunk。

Sources: [package.json](package.json#L1-L82), [vite.config.ts](vite.config.ts#L1-L69)

## 应用入口与初始化流程

应用入口点位于 `app/main.ts`，该文件负责创建 Vue 应用实例、配置全局插件并挂载到 `#app` DOM 节点。`app/App.vue` 作为根组件，组织整体布局结构。页面加载顺序为：`index.html` → `main.ts` → `App.vue` → 子组件树。

### 初始化序列

```
graph LR
    A[index.html] --> B[main.ts]
    B --> C[createApp(App)]
    C --> D[install plugins<br/>i18n/ router/ store]
    D --> E[mount #app]
    E --> F[App.vue render]
    F --> G[Component tree]
```

上述流程中，`main.ts` 是唯一入口，所有全局状态（如国际化实例）在此处创建并注入。由于未在 `package.json` 中发现 Vue Router 依赖，路由可能采用动态组件切换或自定义路由实现，具体实现需进一步查看 `App.vue` 的模板结构。

Sources: [app/main.ts](app/main.ts#L1), [app/App.vue](app/App.vue#L1)

## 组件架构与布局策略

组件目录 `app/components/` 包含约 40 个 Vue 单文件组件，按功能可划分为以下几类：

| 类别 | 组件示例 | 职责 |
|------|---------|------|
| 布局容器 | `SidePanel.vue`, `TopPanel.vue`, `ToolWindow/` | 定义主窗口的左右/上下分区 |
| 会话与消息 | `ThreadBlock.vue`, `ThreadFooter.vue`, `MessageViewer.vue` | 渲染对话线程、消息内容和输入区 |
| 代码相关 | `CodeContent.vue`, `LineCommentOverlay.vue` | 代码高亮、行内评论渲染 |
| 交互控制 | `Dropdown.vue`, `ProjectPicker.vue`, `SettingsModal.vue` | 下拉选择、项目切换、设置弹窗 |
| 状态与主题 | `StatusBar.vue`, `ThemeInjector.vue` | 底部状态栏、主题注入 |
| 悬浮窗 | `FloatingWindow.vue` | 独立可拖拽窗口 |

组件间通信主要依赖 **Props/Events** 父子传递，以及 **Composables** 共享的响应式状态。例如 `ThreadBlock.vue` 通过 `useMessages` 获取消息数据，`useSessionSelection` 管理当前选中会话，`useSettings` 读取用户配置。

Sources: [app/components/](app/components/), [app/composables/useMessages.ts](app/composables/useMessages.ts#L1)

## 组合式函数（Composables）架构

`app/composables/` 目录包含 30+ 个可组合函数，是前端逻辑层核心。这些函数遵循 Vue 3 Composition API 规范，封装了状态管理、副作用和业务逻辑，实现 **关注点分离**。

### 关键 Composables 职责映射

| 文件名 | 核心功能 | 依赖关系 |
|--------|---------|---------|
| `useSettings.ts` | 读写本地存储中的用户设置 | 依赖 `useStorage` 抽象 |
| `useMessages.ts` | 管理会话消息列表、流式更新 | 依赖 `useCodexApi` 获取后端数据 |
| `useCodexApi.ts` | 封装 Codex 后端 API 调用 | 依赖 `useCredentials` 认证 |
| `useCredentials.ts` | 管理 API 密钥、令牌存储 | 依赖浏览器 `localStorage` |
| `useServerState.ts` | 监控本地 server.js 进程状态 | 依赖 SSE 连接 |
| `useFileTree.ts` | 文件树结构读取与展开 | 依赖 `openCodeAdapter` |
| `useFloatingWindow.ts` | 单个悬浮窗位置/大小状态 | 与 `useFloatingWindows` 协同 |
| `useStreamingWindowManager.ts` | 管理多个流式输出窗口 | 依赖 `useReasoningWindows` |

Composables 之间形成 **有向无环图（DAG）**：底层依赖（如 `useCredentials`）被多个上层 composable 复用，避免代码重复。测试文件（如 `useMessages.test.ts`）同步存在，表明采用 **测试驱动开发（TDD）** 或至少配套测试的工程实践。

Sources: [app/composables/](app/composables/), [app/composables/useCodexApi.ts](app/composables/useCodexApi.ts#L1)

## 状态管理与数据流

前端状态分为三类：**本地状态**（组件内部 `ref/reactive`）、**全局共享状态**（通过 composables 提供）、**持久化状态**（`localStorage`/`electron-store`）。

### 数据持久化策略

- 用户设置：`useSettings.ts` 封装 `localStorage` 读写，键名前缀统一为 `vis-`，具体键位定义见 `app/utils/storageKeys.ts`。
- 消息历史：会话数据缓存在内存中，持久化由后端 `server.js` 负责（见 `server.js` 中的文件写入逻辑），前端仅负责展示。
- 供应商配置：`app/utils/providerConfig.ts` 管理 LLM 供应商（如 OpenAI、Anthropic）的 API 端点、模型列表和密钥存储位置。

Sources: [app/utils/storageKeys.ts](app/utils/storageKeys.ts#L1), [app/utils/providerConfig.ts](app/utils/providerConfig.ts#L1)

## 后端桥接与 API 通信

前端通过两种主要方式与后端通信：

1. **HTTP 请求**：使用浏览器原生 `fetch` 或封装后的 `useCodexApi` 调用 `server.js` 提供的 REST 端点（如 `/api/chat`、`/api/files`）。
2. **Server-Sent Events (SSE)**：通过 `app/workers/sse-shared-worker.ts` 和 `app/types/sse.ts` 建立长连接，接收服务器推送的流式消息、文件变更通知等。`useServerState.ts` 负责监控 SSE 连接状态。

### 网络层抽象

`app/utils/sseConnection.ts` 提供 SSE 连接的建立、重连和消息分发，`app/utils/eventEmitter.ts` 实现简单的发布订阅模式，用于组件间解耦事件通知（如 "session:created"、"theme:changed"）。

Sources: [app/workers/sse-shared-worker.ts](app/workers/sse-shared-worker.ts#L1), [app/utils/sseConnection.ts](app/utils/sseConnection.ts#L1)

## Web Workers 多线程架构

项目使用 Web Workers 处理计算密集型任务，避免阻塞 UI 线程。Worker 文件位于 `app/workers/`：

- `render-worker.ts`：负责代码渲染、语法高亮、Markdown 转换等 CPU 密集型操作，由 `useCodeRender.ts` 调用。
- `sse-shared-worker.ts`：共享 Worker，管理多个 SSE 连接，减少连接数开销。

Vite 配置中 `worker: { format: 'es' }` 确保 Worker 以 ES Module 方式加载，与主应用模块系统一致。

Sources: [app/workers/render-worker.ts](app/workers/render-worker.ts#L1), [app/utils/useCodeRender.ts](app/utils/useCodeRender.ts#L1)

## 样式与主题系统

样式基于 **Tailwind CSS v4**（`@tailwindcss/postcss` 和 `@tailwindcss/typography`），采用原子化类名组合。主题切换通过 `ThemeInjector.vue` 和 `useRegionTheme.ts` 实现动态 CSS 变量注入，支持浅色/深色模式。

- `app/styles/tailwind.css` 导入 Tailwind 核心和插件。
- `app/utils/theme.ts` 和 `app/utils/themeRegistry.ts` 定义主题令牌（颜色、间距、字体）和注册机制。
- `app/utils/regionTheme.ts` 支持 **区域主题**（Region-based Theme），允许不同面板使用不同主题，由 `ThemeInjector.vue` 在 DOM 中动态切换 `data-theme` 属性。

Sources: [app/styles/tailwind.css](app/styles/tailwind.css#L1), [app/utils/theme.ts](app/utils/theme.ts#L1)

## 国际化（i18n）系统

项目使用 `vue-i18n@11` 实现多语言支持。语言包位于 `app/locales/`，包含英语（`en.ts`）、世界语（`eo.ts`）、日语（`ja.ts`）、简体中文（`zh-CN.ts`）、繁体中文（`zh-TW.ts`）。`app/i18n/useI18n.ts` 封装 `useI18n` 钩子，提供类型安全的翻译函数。

语言切换通过 `useSettings.ts` 持久化保存，应用启动时读取并初始化 `vue-i18n` 实例。

Sources: [app/locales/zh-CN.ts](app/locales/zh-CN.ts#L1), [app/i18n/useI18n.ts](app/i18n/useI18n.ts#L1)

## 构建与开发工作流

开发环境启动：`pnpm dev` 调用 Vite 开发服务器，监听 `127.0.0.1:5173`，启用 HMR（热模块替换）。生产构建：`pnpm build` 生成静态资源至 `dist/` 目录，随后 `electron-builder` 打包为桌面可执行文件。

### 构建产物结构

```
dist/
├── index.html        # SPA 入口
├── assets/           # 静态资源（js/css/media）
│   ├── vendor-vue-*.js
│   ├── vendor-ui-*.js
│   └── app-*.js
└── schemas/          # JSON Schema 文件（来自 public/schema）
```

构建过程还注入 Git 提交哈希（`__GIT_REVISION__`），用于版本显示和调试。

Sources: [vite.config.ts](vite.config.ts#L45-L54), [package.json](package.json#L31-L34)

## 架构设计原则总结

1. **模块化**：功能按目录（components、composables、utils、workers）清晰分离，便于维护和测试。
2. **响应式优先**：全面使用 Vue 3 的 `ref/reactive` 和 `computed`，状态变更自动驱动视图更新。
3. **关注点分离**：UI 组件仅负责渲染，业务逻辑下沉到 composables，工具函数独立于框架。
4. **可测试性**：关键模块配套 `.test.ts` 文件，使用 Vitest + Happy DOM 运行单元测试。
5. **性能意识**：Web Workers 卸载重计算、手动 chunk 分割、Tailwind 按需生成，共同保障流畅体验。

## 后续探索路径

如需深入了解各子系统实现，建议按以下顺序阅读：

- [技术栈概览](5-ji-zhu-zhan-gai-lan) — 验证本文提到的技术选型背景与版本依赖
- [后端服务与 API](8-hou-duan-fu-wu-yu-api) — 理解 `server.js` 提供的接口与 SSE 协议细节
- [Composables 可组合函数](21-composables-ke-zu-he-han-shu) — 学习状态逻辑复用模式
- [Web Workers 多线程](25-web-workers-duo-xian-cheng) — 掌握多线程渲染与事件处理机制