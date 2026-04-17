本页面提供项目的完整入门指南，涵盖从环境准备到基本操作的全流程。通过阅读本页，您将了解项目的核心架构、安装配置方法、开发环境搭建步骤，以及如何启动并使用这个 OpenCode 可视化界面。

## 项目概述与核心架构

Vis 是一个为 [OpenCode](https://github.com/sst/opencode) 设计的浏览器端可视化界面（Web UI），采用 Vue 3 + Vite 技术栈构建。项目采用**浮动窗口管理系统**作为核心交互范式，所有工具输出和代理推理都以窗口形式悬浮在工作区上方，保持上下文关联性。架构上分为三层：前端 Vue 应用层、Hono 中间层（处理 SSE 和 REST 代理）、以及后端的 OpenCode 服务器通信层。

```
graph TD
    A[浏览器端 Vue 应用] --> B[Hono 中间件服务器]
    B --> C[OpenCode API 服务器]
    B --> D[SSE 事件流]
    B --> E[REST 代理转发]
    
    A --> F[浮动窗口管理器]
    A --> G[会话树组件]
    A --> H[代码渲染器]
    A --> I[终端 PTY 集成]
    
    F --> J[xterm.js 终端]
    H --> K[shiki 语法高亮]
    
    C --> L[MCP 服务器]
    C --> M[LSP 语言服务器]
    C --> N[插件系统]
```

项目支持多项目和多 worktree 管理，内置语法高亮的代码和 diff 查看器，并提供权限问答交互和嵌入式终端功能。值得注意的是，本仓库是上游 [xenodrive/vis](https://github.com/xenodrive/vis) 的中文维护分支，已添加简体中文国际化、字体管理、供应商模型管理等增强功能 [README.md](README.md#L1-L15)。

## 前置环境要求

在开始之前，请确保您的系统满足以下最低要求：

| 项目 | 要求 |
|------|------|
| Node.js | ≥ 20.0.0 |
| 包管理器 | pnpm 10+（推荐）或 npm 9+ |
| 浏览器 | Chrome 120+、Firefox 115+ 或 Safari 17+ |
| OpenCode 版本 | 最新稳定版（需支持 SSE 和 REST API） |
| 操作系统 | Linux、macOS 或 Windows（WSL2 推荐） |

项目使用 ES Module 模块系统，`type` 字段设置为 `module` [package.json](package.json#L33)，因此需要支持 ESM 的 Node.js 环境。开发依赖中包含 Vite 7.x、Vue 3.5.x 和 Vue-i18n 11.x [package.json](package.json#L38-L56)。

## 本地开发环境搭建

### 1. 克隆仓库

```bash
git clone https://github.com/qiyuanhuakai/opencode-visualizer-cn
cd opencode-visualizer-cn
```

### 2. 安装依赖

推荐使用 pnpm 以保持依赖树的一致性（项目使用 pnpm-workspace.yaml 定义工作区）：

```bash
pnpm install
```

如果您使用 npm，也可以运行 `npm install`，但建议使用 pnpm 以获得更好的 monorepo 支持。

### 3. 启动开发服务器

开发模式使用 Vite 的 hot module replacement（HMR），文件变更会实时反映在浏览器中：

```bash
pnpm dev
```

默认启动地址为 `http://localhost:5173`（Vite 默认端口）。开发服务器集成了 Hono 中间件（server.js），负责将 API 请求代理到 OpenCode 服务器，并建立 SSE 连接 [package.json](package.json#L27)。

### 4. 启动 OpenCode 后端

Vis 仅提供前端界面，需要独立的 OpenCode 服务器提供 API 和工具执行能力。在新终端中启动 OpenCode：

```bash
opencode serve
```

默认情况下，OpenCode 监听 `http://localhost:3000`。如需启用 CORS（允许跨域访问，适用于云端部署场景），请使用：

```bash
opencode serve --cors https://your-domain.com
```

或在配置文件中设置 [README.md](README.md#L35-L42)：
```json
{
  "$schema": "https://opencode.ai/config.json",
  "server": {
    "cors": ["https://your-domain.com"]
  }
}
```

### 5. 访问应用

打开浏览器访问 `http://localhost:5173`，应用将自动连接到本地的 OpenCode 服务器。首次加载时，顶部面板会出现项目选择器，用于配置工作目录和 OpenCode 服务器地址 [app/App.vue](app/App.vue#L18-L24)。

## 生产构建与部署

### 构建静态资源

执行以下命令生成优化后的生产版本：

```bash
pnpm build
```

构建产物将输出到 `dist/` 目录，包含静态资源、index.html 和客户端 JavaScript 包 [package.json](package.json#L28)。Vite 配置使用默认的构建选项（未找到自定义配置），输出格式为 ESM 和 IIFE 混合以兼容不同浏览器环境。

### 启动生产服务器

生产模式下，需要同时启动 Hono 中间件服务器来提供静态文件并代理 API 请求：

```bash
node server.js
```

服务器默认监听 3000 端口（可通过环境变量 `PORT` 覆盖）。推荐使用 nohup 或 systemd 持久化运行 [README.md](README.md#L49-L51)：

```bash
nohup node server.js 2>&1 &
```

此时应用可通过 `http://localhost:3000` 访问。

### Docker 部署（可选）

虽然项目未提供官方 Dockerfile，但可以基于以下 Dockerfile 自定义构建：

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
```

构建并运行：

```bash
docker build -t vis-app .
docker run -p 3000:3000 vis-app
```

## 应用界面导览

Vis 的界面采用 IDE 风格的多面板布局，包含以下核心区域：

| 区域 | 组件 | 功能描述 |
|------|------|----------|
| 顶部面板 | TopPanel | 项目选择器、会话管理、批量操作、设置入口 [app/components/TopPanel.vue](app/components/TopPanel.vue) |
| 侧边栏 | SidePanel | 会话列表、文件树、Git 状态显示 [app/components/SidePanel.vue](app/components/SidePanel.vue) |
| 主输出区 | OutputPanel | 消息流、工具输出、代码渲染 [app/components/OutputPanel.vue](app/components/OutputPanel.vue) |
| 底部输入区 | InputPanel | 消息输入、模式选择、附件管理 [app/components/InputPanel.vue](app/components/InputPanel.vue) |
| 浮动窗口层 | FloatingWindow | 可拖拽、最小化的工具窗口容器 [app/components/FloatingWindow.vue](app/components/FloatingWindow.vue) |
| 底部 Dock | app-dock-panel | 最小化窗口的快捷恢复栏 [app/App.vue](app/App.vue#L89-L100) |

应用入口文件 `main.ts` 创建 Vue 应用实例并注入国际化插件，同时动态添加 CSS Custom Highlight API 样式以支持搜索高亮 [app/main.ts](app/main.ts#L1-L28)。主组件 `App.vue` 管理全局状态（如 `uiInitState`、`selectedSessionId`、`sidePanelCollapsed`）并通过事件总线与子组件通信 [app/App.vue](app/App.vue#L1-L50)。

## 核心功能快速体验

### 创建第一个会话

1. 在顶部面板点击 **New Session** 按钮
2. 选择工作目录（支持多项目切换）
3. 输入初始消息（如 "帮我查看当前目录结构"）
4. 按 Enter 或点击 Send 提交

会话创建后，OpenCode 会初始化该目录的上下文，并在 OutputPanel 中实时显示代理的推理过程和工具调用结果 [app/components/OutputPanel.vue](app/components/OutputPanel.vue)。

### 使用浮动窗口

当工具输出需要独立查看时（例如代码审查、测试结果），系统会自动创建浮动窗口。您可以：

- **拖动**：按住标题栏移动窗口位置
- **最小化**：点击窗口右上角 `_` 按钮，窗口将收缩到底部 Dock
- **关闭**：点击 `×` 按钮销毁窗口
- **聚焦**：点击窗口任意位置将其置顶

浮动窗口管理器位于 `app/composables/useFloatingWindows.ts`，采用 Z-index 层级策略确保活动窗口始终在最上层 [app/composables/useFloatingWindows.ts](app/composables/useFloatingWindows.ts#L1-L50)。

### 查看文件与代码

点击文件树中的文件可在内置查看器中打开，支持语法高亮和行号显示。代码渲染基于 [shiki](https://github.com/shikijs/shiki) 引擎，主题可随系统主题切换 [app/utils/useCodeRender.ts](app/utils/useCodeRender.ts#L1-L100)。查看器组件位于 `app/components/viewers/` 目录下。

### 终端集成

内置终端基于 xterm.js 实现，支持常见的 Shell 操作。在会话中输入 `shell` 命令或点击输入面板的终端图标即可打开终端窗口。PTY 集成通过 WebSocket 与后端通信，详情见 [终端与 PTY 集成](17-zhong-duan-yu-pty-ji-cheng)。

## 配置与个性化

### 设置面板

点击顶部面板右侧的 **Settings** 按钮打开设置模态框，可调整以下选项 [app/components/SettingsModal.vue](app/components/SettingsModal.vue)：

- **界面主题**：跟随系统或手动切换亮/暗模式
- **字体设置**：终端字体和界面等宽字体（支持系统字体自动发现） [app/utils/fontDiscovery.ts](app/utils/fontDiscovery.ts#L1-L80)
- **窗口行为**：是否自动最小化、Dock 显示开关
- **区域主题**：为不同文件类型指定语法高亮主题 [app/utils/regionTheme.ts](app/utils/regionTheme.ts#L1-L120)

### 供应商与模型管理

在 **Provider Manager** 中可查看可用的大语言模型供应商及其模型列表，支持启用/禁用特定模型（仅本地生效） [app/components/ProviderManagerModal.vue](app/components/ProviderManagerModal.vue)。该功能通过 `app/composables/useSettings.ts` 读取持久化配置实现 [app/composables/useSettings.ts](app/composables/useSettings.ts#L100-L200)。

### 状态监控

Status Monitor 面板显示服务器、MCP、LSP、插件和 skills 的运行状态，并提供关闭 MCP 连接的调试功能 [app/components/StatusMonitorModal.vue](app/components/StatusMonitorModal.vue)。状态数据通过 SSE 推送，相关逻辑位于 `app/composables/useServerState.ts` [app/composables/useServerState.ts](app/composables/useServerState.ts#L1-L150)。

## 常见问题排查

### 连接失败

如果页面显示 "Connection Error" 或无法加载会话：

1. 确认 OpenCode 服务器正在运行：`curl http://localhost:3000/health`
2. 检查 CORS 配置：确保 OpenCode 允许当前前端域
3. 查看浏览器控制台网络请求，确认 SSE 连接是否建立 [app/utils/sseConnection.ts](app/utils/sseConnection.ts#L1-L100)

### 端口冲突

默认端口 3000 可能与 Windows 服务冲突（WSL 环境常见）。可通过环境变量修改：

```bash
PORT=8080 node server.js
```

或修改 OpenCode 的端口配置 [README.md](README.md#L25)。

### 字体显示异常

如果终端或代码查看器字体渲染不正确，请进入设置面板重新选择字体，或点击 "Discover System Fonts" 按钮自动检测可用字体 [app/utils/fontDiscovery.ts](app/utils/fontDiscovery.ts#L20-L60)。

### 性能优化建议

对于超大会话（超过 1000 条消息），项目已实现懒加载和后台水合（background hydration）以提升冷启动速度 [README.md](README.md#L32-L35)。如仍遇到卡顿，可尝试：
- 减少同时打开的浮动窗口数量
- 在设置中禁用动画效果
- 使用最新版 Chrome 或 Edge 浏览器

## 下一步学习路径

掌握快速开始内容后，建议按以下顺序深入系统各个模块：

1. **[系统架构概览](5-xi-tong-jia-gou-gai-lan)** - 理解整体数据流和组件关系
2. **[浮动窗口管理系统](6-fu-dong-chuang-kou-guan-li-xi-tong)** - 掌握核心交互模式
3. **[SSE 实时通信机制](9-sse-shi-shi-tong-xin-ji-zhi)** - 了解事件驱动架构
4. **[组合式 API (Composables) 详解](13-zu-he-shi-api-composables-xiang-jie)** - 学习状态管理模式
5. **[工具窗口组件系统](15-gong-ju-chuang-kou-zu-jian-xi-tong)** - 掌握可复用组件设计

如需直接查找 API 或工具文档，请参阅：[REST API 完整参考](26-rest-api-wan-zheng-can-kao)、[SSE 事件流规范](27-sse-shi-jian-liu-gui-fan)、[工具定义文档](28-gong-ju-ding-yi-wen-dang)。