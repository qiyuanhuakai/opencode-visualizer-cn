本文档面向初次接触 OpenCode Visualizer CN 的开发者，帮助你从源码克隆到成功运行本地服务，并在浏览器中完成第一次 AI 对话。我们将按照「环境准备 → 依赖安装 → 构建启动 → 首次连接 → 后续阅读」的顺序展开，每一步都附有可直接执行的命令和关键配置说明。

Sources: [README.md](README.md#L1-L80), [package.json](package.json#L1-L30)

---

## 环境要求

在克隆仓库之前，请确认本地环境满足以下最低要求。这些依赖是项目构建和运行的必要条件。

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 运行时与构建环境 |
| pnpm | 10.29.3（推荐） | 包管理器，`packageManager` 字段已锁定 |
| OpenCode Server | 最新版 | 后端服务，提供 SSE 事件流与 REST API |
| 系统 `$EDITOR` | 可选 | 用于「用编辑器打开」功能 |

> **提示**：本项目默认服务端口已从 `3000` 修改为 `23003`，以减少 WSL 与 Windows 服务的端口冲突。若需自定义端口，可在启动时设置 `VIS_PORT` 环境变量。

Sources: [README.md](README.md#L95-L115), [package.json](package.json#L70-L72)

---

## 克隆与安装

执行以下命令将仓库克隆到本地并安装所有依赖。项目使用 pnpm workspace 管理依赖，因此必须确保使用 pnpm 而非 npm/yarn。

```bash
git clone https://github.com/qiyuanhuakai/opencode-visualizer-cn
cd opencode-visualizer-cn
pnpm install
```

安装完成后，项目根目录下的 `node_modules` 将包含前端（Vue 3 + Vite）、后端静态服务（Hono）以及 Electron 桌面端所需的全部依赖。

Sources: [README.md](README.md#L117-L120), [package.json](package.json#L1-L85)

---

## 构建前端

前端源码位于 `app/` 目录，构建工具为 Vite。执行以下命令进行生产构建：

```bash
pnpm build
```

构建产物将输出到 `dist/` 目录，包含经过压缩的 HTML、JS、CSS 以及字体和图标等静态资源。`server.js` 会直接从 `dist/` 目录提供这些文件。

Sources: [README.md](README.md#L120), [vite.config.ts](vite.config.ts#L1-L69)

---

## 启动服务

构建完成后，使用 Node.js 直接启动静态服务器：

```bash
node server.js
```

若需要后台持久运行，建议使用：

```bash
nohup node server.js 2>&1 &
```

服务默认监听 `http://127.0.0.1:23003`。打开浏览器访问该地址，即可看到登录界面。

Sources: [server.js](server.js#L1-L44), [README.md](README.md#L120-L123)

---

## 首次连接

### 1. 确保 OpenCode Server 已运行

Visualizer 是一个纯前端应用，所有 AI 能力都依赖后端的 OpenCode Server。请确认你的 OpenCode Server 已经在默认端口 `4096` 上运行，或者你知道它的实际地址。

### 2. 填写连接信息

在浏览器中打开 `http://localhost:23003` 后，你会看到登录界面。需要填写的信息包括：

| 字段 | 说明 |
|---|---|
| 后端 | 选择 `OpenCode`（默认）或 `Codex` |
| URL | OpenCode Server 地址，默认 `http://localhost:4096` |
| 用户名 / 密码 | 如果服务器启用了 Basic Auth，请在此填写 |

点击「连接」后，前端会通过 SSE（Server-Sent Events）与后端建立实时事件流，随后自动加载项目、会话和文件树。

Sources: [app/locales/zh-CN.ts](app/locales/zh-CN.ts#L1-L30), [app/utils/constants.ts](app/utils/constants.ts#L1-L2)

---

## 项目结构速览

理解目录结构有助于你快速定位源码和配置文件。以下是核心目录的职责说明：

```
opencode-visualizer-cn/
├── app/                    # 前端源码（Vue 3 + TypeScript）
│   ├── components/         # Vue 组件
│   ├── composables/        # 组合式函数（状态与逻辑）
│   ├── backends/           # 后端适配器（OpenCode / Codex）
│   ├── workers/            # Web Worker 与 Shared Worker
│   ├── utils/              # 工具函数
│   ├── types/              # TypeScript 类型定义
│   ├── locales/            # 多语言文件
│   └── styles/             # Tailwind CSS 样式
├── docs/                   # 项目文档与截图
├── electron/               # Electron 主进程与预加载脚本
├── build/                  # 桌面端构建资源（图标、签名配置）
├── dist/                   # 前端构建产物（由 Vite 生成）
├── server.js               # 生产环境静态服务器
├── vis_bridge.js           # Codex 桥接器
└── package.json            # 项目配置与脚本
```

Sources: [README.md](README.md#L1-L80)

---

## 常用开发命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 启动 Vite 开发服务器（带热更新） |
| `pnpm build` | 生产构建前端 |
| `pnpm test` | 运行 Vitest 单元测试 |
| `pnpm lint` | 运行 oxlint + vue-tsc 检查 |
| `pnpm format` | 运行 oxfmt 格式化代码 |
| `pnpm electron:start` | 启动 Electron 开发模式 |
| `pnpm electron:build` | 构建桌面端安装包 |

Sources: [package.json](package.json#L15-L28)

---

## 下一步

完成以上步骤后，你已经成功运行了 OpenCode Visualizer CN。建议按照以下顺序继续阅读文档，深入理解项目的架构与功能：

1. **[项目概览](1-xiang-mu-gai-lan)** — 了解项目的定位、功能特性与改进方向
2. **[技术栈与环境要求](3-ji-zhu-zhan-yu-huan-jing-yao-qiu)** — 深入理解各技术选型的原因与版本约束
3. **[Vue 3 应用入口与生命周期](5-vue-3-ying-yong-ru-kou-yu-sheng-ming-zhou-qi)** — 从 `main.ts` 到 `App.vue` 的启动流程
4. **[SSE 连接管理与事件协议](8-sse-lian-jie-guan-li-yu-shi-jian-xie-yi)** — 理解前端如何实时接收服务器事件
5. **[提供商与模型管理](25-ti-gong-shang-yu-mo-xing-guan-li)** — 配置和管理 AI 提供商与模型