欢迎阅读 Vis 项目文档。本文档作为入门指南的第一部分，将帮助您快速理解 Vis 是什么、它的核心能力以及基本架构。Vis 是 OpenCode 的替代性 Web UI，提供基于浏览器的窗口式界面，用于实时管理会话、查看工具输出以及与 AI 代理交互。本页面涵盖项目的起源、核心功能、技术架构概览以及快速入门指引，为后续深入学习系统架构、核心模块和开发指南奠定基础。

## 项目简介
Vis 最初是 [上游仓库](https://github.com/xenodrive/vis) 的 fork，由于上游不接受 PR，因此作为独立项目持续维护，并添加了多项功能改进和本地化支持。该项目为 OpenCode 构建第三方 Web UI，允许用户通过浏览器访问 OpenCode 服务器的功能，提供类似于桌面 IDE 的窗口管理体验。项目本身**并非**由 OpenCode 团队开发，与其**没有**任何关联。

核心设计理念是"先审查"的浮动窗口系统，让工具输出和代理推理保持上下文关联。用户可以在同一界面中管理多项目会话、查看语法高亮的代码和差异、处理权限和问答提示，以及使用嵌入式的 xterm.js 终端。项目支持国际化，已添加简体中文语言支持，并实现了字体管理、供应商模型管理、状态监控、会话固定、批量操作等增强功能。

Sources: [README.md](README.md#L1-L44)

## 核心功能特性
Vis 提供以下核心能力，使其成为 OpenCode 的高效可视化前端：

| 功能模块 | 主要能力 | 技术实现 |
|---------|---------|---------|
| 浮动窗口管理 | 工具输出和代理推理的上下文关联审查 | Vue 3 响应式状态 + 窗口管理器 |
| 会话管理 | 多项目、多工作树支持，会话固定与归档 | 组合式 API + 本地存储 |
| 代码查看器 | 语法高亮、差异对比、快速审查 | Shiki 语法高亮 + 自定义渲染器 |
| 权限与交互 | 权限提示、问答流程、代理调用确认 | 组合式权限系统 + 事件总线 |
| 终端集成 | 嵌入式 PTY 终端，支持 shell 命令执行 | xterm.js + Web Worker |
| 实时通信 | SSE 事件流，支持工具调用和流式响应 | SharedWorker + 事件源 |
| 国际化 | 完整的中英文界面支持 | vue-i18n + 语言资源文件 |
| 字体与主题 | 系统字体自动发现、界面字体配置 | 字体探测 API + CSS 变量 |
| 供应商管理 | 查看和管理 AI 供应商与模型 | 供应商 API 集成 + 本地配置 |
| 状态监控 | 服务器、MCP、LSP、插件状态查看 | 状态查询 API + 模态窗口 |

Sources: [README.md](README.md#L45-L72)

## 技术栈与架构
Vis 采用现代前端技术栈构建，后端使用轻量级 Hono 服务器提供静态文件服务和代理功能：

**前端核心框架**：Vue 3（响应式组件系统）+ TypeScript（类型安全）+ Vite（快速构建）

**样式与UI**：Tailwind CSS（原子化样式）+ 自定义组件库（浮动窗口、面板、对话框）

**代码渲染**：Shiki（TextMate 语法高亮）+ markdown-it（Markdown 解析）+ @xterm/xterm（终端模拟）

**国际化**：vue-i18n 11.x（多语言支持）

**后端服务**：Hono 4.x（Node.js 服务器）+ @hono/node-server（静态文件服务）

**开发工具**：Vitest（单元测试）+ Oxlint/Oxfmt（代码质量）+ Vue-TSC（类型检查）

**包管理**：pnpm（工作区管理）

Sources: [package.json](package.json#L1-L63) | [vite.config.ts](vite.config.ts#L1-L55) | [server.js](server.js#L1-L44)

## 项目目录结构
Vis 采用模块化目录组织，关键目录包括：

```
app/                    # 前端应用源代码
├── components/         # Vue 组件（面板、窗口、查看器）
│   ├── renderers/     # 内容渲染器（代码、Markdown、图片）
│   └── viewers/       # 内容查看器（文件、Git 差异）
├── composables/       # Vue 组合式函数（状态管理、API 调用）
├── i18n/              # 国际化配置
├── locales/           # 语言资源（en.ts, zh-CN.ts）
├── styles/            # 全局样式（Tailwind）
├── types/             # TypeScript 类型定义
├── utils/             # 工具函数（事件、格式化、路径）
├── workers/           # Web Workers（渲染、SSE 共享）
└── main.ts            # 应用入口

docs/                  # 项目文档（Markdown）
dist/                  # 构建输出目录（gitignore）
server.js              # Node.js 服务器入口
```

Sources: [get_dir_structure](app#L1-L68)

## 系统架构概览
Vis 的架构设计遵循清晰的分层模式，主要包含以下层次：

1. **表示层**：Vue 3 组件树（App.vue 根组件 + 子组件），负责 UI 渲染和用户交互
2. **状态管理层**：Composables（useMessages、useSettings、useServerState 等）管理全局和局部状态
3. **通信层**：SSE（Server-Sent Events）通过 SharedWorker 维持与 OpenCode 服务器的持久连接
4. **渲染层**：Web Workers 处理 Markdown、代码高亮、差异计算等耗时操作
5. **服务层**：Hono 服务器提供静态资源服务，可选代理模式连接到远程 UI 资源

架构的核心是浮动窗口管理系统，允许工具输出以独立窗口形式悬浮于主界面，支持最小化、停靠、层级管理。所有实时数据通过 SSE 事件流从 OpenCode 服务器推送，Worker 负责在后台解析和渲染内容，确保主线程响应性。

Sources: [app/main.ts](app/main.ts#L1-L28) | [docs/window-arch.md](docs/window-arch.md) | [docs/SSE.md](docs/SSE.md)

## 快速开始
根据您的使用场景，可选择以下部署方式：

**本地开发**（推荐用于贡献代码）：
```bash
git clone https://github.com/qiyuanhuakai/opencode-visualizer-cn
cd opencode-visualizer-cn
pnpm install
pnpm dev
```
访问 `http://localhost:5173`（Vite 开发服务器），同时需要运行 OpenCode 服务器：
```bash
opencode serve --cors http://localhost:5173
```

**本地构建运行**：
```bash
pnpm build
node server.js
```
访问 `http://localhost:23003`，OpenCode 服务器需启用 CORS 指向该地址。

**云端使用**（无需安装）：
直接访问 [https://xenodrive.github.io/vis/](https://xenodrive.github.io/vis/)，OpenCode 服务器启动参数：
```bash
opencode serve --cors https://xenodrive.github.io
```
或在配置文件中添加 CORS 设置。

Sources: [README.md](README.md#L73-L125) | [server.js](server.js#L31-L44)

## 下一步学习建议
根据您的兴趣和技术背景，建议按以下路径深入：

- **[快速开始](2-kuai-su-kai-shi)**：获取完整的环境搭建和运行步骤，包括依赖安装、配置说明和常见问题解决
- **[系统架构概览](5-xi-tong-jia-gou-gai-lan)**：深入理解 Vis 的分层设计、核心数据流和模块交互关系
- **[浮动窗口管理系统](6-fu-dong-chuang-kou-guan-li-xi-tong)**：学习窗口创建、层级管理、最小化停靠等核心交互机制
- **[SSE 实时通信机制](9-sse-shi-shi-tong-xin-ji-zhi)**：理解 Server-Sent Events 如何实现与 OpenCode 的双向实时通信
- **[组合式 API (Composables) 详解](13-zu-he-shi-api-composables-xiang-jie)**：掌握 Vue 组合式函数的状态管理和逻辑复用模式