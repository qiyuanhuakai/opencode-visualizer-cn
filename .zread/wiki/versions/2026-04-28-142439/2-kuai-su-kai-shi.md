本页面为初学者提供项目的一站式启动指南，涵盖环境准备、基础部署、开发模式启动以及可选的高级功能配置。通过本指南，你将在 5 分钟内运行起完整的 OpenCode Visualizer CN 环境，并理解其核心架构与依赖关系。

## 一、项目本质与架构概览
OpenCode Visualizer CN 是一个为 OpenCode 构建的第三方 Web UI，采用 **前后端分离 + 桌面端封装** 的三层架构模式。前端基于 Vue 3 + Vite 构建响应式界面，后端使用 Hono 提供轻量级 HTTP 服务，并通过 Electron 实现跨平台桌面应用打包。

```
graph TD
    A[用户界面层] --> B[API 网关层]
    B --> C[OpenCode Server]
    A --> D[桌面端封装]
    
    subgraph A [前端 UI 层]
        A1[Vue 3 SPA]
        A2[xterm.js 终端]
        A3[Shiki 代码高亮]
        A4[Vue I18n 国际化]
    end
    
    subgraph B [后端服务层]
        B1[Hono HTTP 服务器]
        B2[SSE 事件流]
        B3[文件系统操作]
        B4[MCP / LSP 集成]
    end
    
    subgraph D [桌面应用层]
        D1[Electron 主进程]
        D2[安全沙箱]
        D3[系统集成]
    end
    
    C -->|JSON-RPC / API| B
```

**Sources: [README.md](README.md#L1-L50)**

## 二、环境要求与依赖说明
在开始前，请确保环境满足以下版本要求。本项目使用 **pnpm** 作为包管理器，并通过 `packageManager` 字段锁定版本，确保团队开发一致性。

| 依赖项 | 版本要求 | 验证命令 | 说明 |
|---|---|---|---|
| Node.js | ≥ 20.0.0 | `node --version` | 运行时与构建环境，推荐使用 LTS 版本 |
| pnpm | 10.29.3 | `pnpm --version` | 包管理器，通过 Corepack 或独立安装 |
| OpenCode Server | 最新版 | `opencode --version` | 后端智能体服务，需独立运行 |
| 系统 $EDITOR | 可选 | `echo $EDITOR` | 用于"用编辑器打开"功能 |

> **关键提示**：项目默认端口从上游的 `3000` 修改为 `23003`，以避免在 WSL 环境下与 Windows 服务产生端口冲突。若端口被占用，可在 `server.js` 中调整。

**Sources: [README.md](README.md#L66-L78)**

## 三、核心依赖解析
理解项目依赖有助于诊断问题与扩展功能。以下是关键依赖的分类说明：

### 3.1 前端运行时依赖
- **Vue 3**：响应式 UI 框架，使用 Composition API 组织组件逻辑
- **Vue I18n**：多语言支持，已内置简体中文、繁体中文、日语、世界语
- **xterm.js**：基于 Web 的终端模拟器，支持 Shell 交互
- **Shiki**：语法高亮引擎，基于 TextMate grammar 提供精确着色
- **vue-pdf-embed**：PDF 文档嵌入式查看器

### 3.2 后端服务依赖
- **Hono**：轻量级 Web 框架，运行在 Node.js 环境
- **@hono/node-server**：Hono 的 Node.js 服务适配器
- **jszip / fflate / libarchive-wasm**：压缩包解析库，支持多种归档格式
- **buffer**：Node.js Buffer  polyfill，确保浏览器环境兼容性

**Sources: [package.json](package.json#L1-L60)**

## 四、快速部署步骤（5 分钟版）
按照以下顺序执行命令，即可启动完整服务。**注意**：步骤 2 要求 OpenCode Server 已提前运行。

```bash
# 步骤 1：克隆仓库并进入目录
git clone https://github.com/qiyuanhuakai/opencode-visualizer-cn
cd opencode-visualizer-cn

# 步骤 2：安装依赖（自动读取 packageManager 锁定 pnpm 版本）
pnpm install

# 步骤 3：构建前端产物
pnpm build

# 步骤 4：启动后端 HTTP 服务
node server.js
```

**后台持久化运行**（推荐用于生产环境）：
```bash
nohup node server.js 2>&1 &
```

访问 `http://localhost:23003` 即可看到主界面。

**Sources: [README.md](README.md#L108-L119)**

## 五、vis_bridge 桥接器配置（可选，Codex 集成）
vis_bridge 是一个轻量级桥接器，用于将 Codex CLI 的 `app-server` JSON-RPC 协议转发到 Vis 前端，使 Codex Panel 实验性功能能够正常工作。

### 5.1 前置条件
确保已安装 OpenAI Codex CLI 且 `codex` 命令在 PATH 中：
```bash
codex --version
```
若未安装，请参考 [OpenAI Codex 官方文档](https://github.com/openai/codex) 进行安装。

### 5.2 启动流程
在**两个独立的终端窗口**中分别执行：

**终端 1：启动 Codex app-server**
```bash
codex app-server --listen ws://127.0.0.1:4500
```
该命令会在 `ws://127.0.0.1:4500` 启动 WebSocket 服务，供 vis_bridge 连接。

**终端 2：启动 vis_bridge 转发器**
```bash
node vis_bridge.js --target ws://127.0.0.1:4500
```
该桥接器会连接到 Codex app-server，并将消息转发到 Vis 前端的 Codex Panel。

### 5.3 前端启用
1. 打开 Vis 界面，进入"设置"（Settings）
2. 找到"实验性功能"区域，开启"Codex Panel"开关
3. 界面右上角会出现 Codex Panel 按钮
4. 点击按钮并连接到 `ws://127.0.0.1:4500`（vis_bridge 自动管理）

> **警告**：Codex Panel 目前为 Alpha 状态，功能可能不稳定，且需要有效的 OpenAI API 密钥与 Codex CLI 权限。

**Sources: [README.md](README.md#L122-L152)**

## 六、开发模式启动流程
开发模式下，Vite 提供热重载（HMR）与源映射（sourcemap），便于实时调试。

```bash
# 安装依赖（仅首次或依赖变更时需要）
pnpm install

# 启动开发服务器
pnpm dev
```
开发服务器默认监听 `http://127.0.0.1:5173`（Vite 默认端口）。若端口冲突，可在 `vite.config.ts` 中修改 `server.port` 配置。

**构建生产环境产物**：
```bash
pnpm build
```
构建输出位于 `dist/` 目录，包含静态资源与索引 HTML。

**Sources: [README.md](README.md#L174-L184)**

## 七、Electron 桌面端开发与打包
本项目支持将 Web UI 打包为原生桌面应用，覆盖 Windows、macOS、Linux 三大平台。

### 7.1 桌面端开发模式
```bash
pnpm electron:start
```
该命令会自动检测 `127.0.0.1:5173` 上是否有 Vite 开发服务器：
- 若检测到，直接复用并启动 Electron 窗口
- 若未检测到，自动运行 `pnpm dev` 并等待就绪

**开发模式特性**：
- 热重载支持，修改代码即时反映到窗口
- 自动处理 CORS 头部，便于本地 API 调试
- 开发者工具可通过快捷键打开

### 7.2 构建与打包
```bash
# 预览构建（生成 dist/ 但不打包安装包）
pnpm electron:preview

# 完整构建（生成各平台安装包）
pnpm electron:build
```

**构建产物输出**：
- **Windows**：`dist-electron/*.exe`（NSIS 安装器）
- **macOS**：`dist-electron/*.dmg` / `.zip`（Intel / Apple Silicon 通用）
- **Linux**：`dist-electron/*.AppImage` / `.deb`

**安全配置**：
桌面应用启用了 `contextIsolation` 与 `sandbox`，外部链接通过系统默认浏览器打开，确保沙箱安全性。

**Sources: [README.md](README.md#L186-L218)**

## 八、关键技术栈与工具链
下表总结了项目的核心技术选择及其作用：

| 类别 | 技术方案 | 版本 | 核心作用 |
|---|---|---|---|
| 前端框架 | Vue 3 | ^3.4.0 | 组件化 UI，响应式状态管理 |
| 构建工具 | Vite | ^5.0.0 | 极速开发服务器与生产构建 |
| 样式方案 | Tailwind CSS v4 | latest | 原子化 CSS，无需编写样式文件 |
| 终端组件 | xterm.js | ^5.3.0 | 嵌入式 Shell 交互与命令执行 |
| 代码高亮 | Shiki | ^1.15.0 | TextMate grammar 语法高亮 |
| 国际化 | Vue I18n | ^11.3.0 | 多语言文本管理 |
| 后端框架 | Hono | ^4.12.3 | 轻量级 HTTP 服务与路由 |
| 桌面框架 | Electron | ^28.0.0 | 跨平台原生应用封装 |
| 测试框架 | Vitest | ^1.0.0 | 单元测试与快照比对 |
| 代码检查 | oxlint | latest | 高性能 JavaScript/TypeScript Linter |

**Sources: [README.md](README.md#L46-L64)**

## 九、下一步学习路径建议
完成快速启动后，建议按以下顺序深入学习项目架构与开发模式：

1. **[项目概述](1-xiang-mu-gai-shu)** — 了解项目背景、核心改进方向与功能全景
2. **[技术栈概览](5-ji-zhu-zhan-gai-lan)** — 深入各技术选型的原理与集成方式
3. **[前端架构设计](6-qian-duan-jia-gou-she-ji)** — 理解 Vue 组件组织、状态管理与路由设计
4. **[后端服务与 API](8-hou-duan-fu-wu-yu-api)** — 学习 Hono 服务、SSE 事件流与 API 设计
5. **[vis_bridge 桥接器](9-vis_bridge-qiao-jie-qi)** — 掌握桥接器原理与自定义协议转换
6. **[项目目录结构](20-xiang-mu-mu-lu-jie-gou)** — 熟悉文件组织规范与模块边界
7. **[Composables 可组合函数](21-composables-ke-zu-he-han-shu)** — 学习 Vue Composition API 的最佳实践

**Sources: [README.md](README.md#L1-L50)**

## 十、常见问题排查
| 症状 | 可能原因 | 解决方案 |
|---|---|---|
| 页面无法访问 `http://localhost:23003` | 后端服务未启动 | 确认 `node server.js` 正在运行，检查端口占用 |
| 前端资源加载失败 | 未执行 `pnpm build` | 重新运行构建命令，确认 `dist/` 目录存在 |
| vis_bridge 连接失败 | Codex app-server 未运行 | 确认终端 1 中的 `codex app-server` 已成功启动 |
| Electron 窗口白屏 | 开发服务器端口错误 | 确认 Vite 运行在 `5173`，或修改 `electron/main.js` 中的 URL |
| 字体显示异常 | 系统字体未发现 | 检查 `fontDiscovery.ts` 逻辑，手动配置字体路径 |

**Sources: [package.json](package.json#L31-L46)**