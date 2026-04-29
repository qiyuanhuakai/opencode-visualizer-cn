本页面详细说明运行本项目所需的所有软件、服务和配置条件。作为 OpenCode 的第三方 Web UI 实现，项目依赖 OpenCode Server 提供后端 API 与智能体能力，同时需要现代 Node.js 运行时环境支持构建与开发流程。

## 核心依赖版本要求

项目采用严格的版本锁定策略，确保开发、构建与生产环境的一致性。所有依赖版本均通过 `package.json` 中的 `packageManager` 字段和 `pnpm-lock.yaml` 锁定。

| 依赖项 | 最低版本 | 推荐版本 | 用途说明 |
|---|---|---|---|
| Node.js | 20.0.0 | 22.x LTS | 运行时与构建环境，提供原生 ESM 支持与 Web API |
| pnpm | 8.0.0 | 10.29.3 | 包管理器，使用 `packageManager` 字段锁定版本 |
| OpenCode Server | 最新版 | 最新版 | 后端服务，提供 API 与智能体能力 |

**版本验证方法**：
```bash
node --version    # 应输出 v20.x 或更高
pnpm --version    # 应输出 10.29.3 或兼容版本
```

Sources: [README.md](README.md#L81-L90)

## Node.js 运行时环境

Node.js 是本项目的唯一受支持 JavaScript 运行时。项目使用现代 ESM 模块系统，要求 Node.js 提供完整的 ESM 支持与最新的 Web API。

**关键要求**：
- **ESM 支持**：项目完全使用 ES Modules，Node.js 必须启用原生 ESM 支持（Node.js 20+ 默认支持）
- **Web API 兼容**：部分代码使用 `fetch`、`WebSocket` 等浏览器 API 的 Node.js  polyfill
- **类型检查**：TypeScript 编译依赖 `tsconfig.json` 中的 `moduleResolution: "bundler"` 设置，需要 Node.js 20+ 的模块解析能力

**安装建议**：
- 使用 [nvm](https://github.com/nvm-sh/nvm) 或 [fnm](https://github.com/Schniz/fnm) 管理 Node.js 版本
- 开发环境建议使用 Node.js 22.x LTS 获得最佳性能与安全性
- 生产环境建议使用 Node.js 20.x LTS 确保稳定性

Sources: [package.json](package.json#L1-L10), [tsconfig.json](tsconfig.json#L1-L30)

## 包管理器配置

项目强制使用 pnpm 作为包管理器，通过 `package.json` 中的 `packageManager` 字段锁定版本，确保所有开发者使用相同的依赖解析算法与锁定文件格式。

**pnpm 工作空间配置**：
`pnpm-workspace.yaml` 定义了工作空间范围，当前项目为单包工作空间：
```yaml
packages:
  - "."
```

**依赖安装**：
```bash
# 首次安装（自动使用锁定的 pnpm 版本）
pnpm install

# 或显式指定 pnpm 版本
pnpm install --no-frozen-lockfile  # 允许更新 lockfile
```

**依赖分类**：
- **生产依赖** (`dependencies`)：Vue 3、Vite、Hono 等运行时必需库
- **开发依赖** (`devDependencies`)：TypeScript、Vitest、ESLint、oxlint 等工具链
- **peerDependencies**：Electron（仅桌面端需要）

Sources: [package.json](package.json#L11-L50), [pnpm-workspace.yaml](pnpm-workspace.yaml)

## OpenCode Server 后端服务

项目是 OpenCode 的前端实现，必须搭配 OpenCode Server 使用。OpenCode Server 提供核心的 AI 代理能力、文件系统操作与 SSE 事件流服务。

**安装与运行**：
```bash
# 1. 克隆 OpenCode 仓库（需要 Go 环境）
git clone https://github.com/sst/opencode.git
cd opencode

# 2. 构建服务器
go build -o opencode-server ./cmd/server

# 3. 启动服务器（默认端口 51060）
./opencode-server
```

**端口配置**：
- 默认端口：`51060`
- 可通过 `--port` 标志修改
- 本项目前端默认连接到 `http://localhost:51060`

**服务验证**：
访问 `http://localhost:51060/health` 应返回 `{"status":"ok"}`。

Sources: [README.md](README.md#L81-L90)

## 系统环境变量与配置

项目依赖以下系统环境变量或配置文件：

### `$EDITOR` 环境变量（可选）
用于"用编辑器打开"功能，支持 VS Code、Neovim、Sublime Text 等编辑器：
```bash
export EDITOR="code --wait"    # VS Code
export EDITOR="nvim"           # Neovim
export EDITOR="subl -n -w"     # Sublime Text
```

### 网络端口配置
- **开发服务器**：`23003`（Vite 开发服务器，已从默认 3000 修改以避免 WSL 冲突）
- **后端 API**：`51060`（OpenCode Server 默认端口）
- **vis_bridge 服务**：`4500`（Codex app-server WebSocket 转发端口）

**端口冲突检查**：
```bash
# 检查端口占用
lsof -i :23003
lsof -i :51060
lsof -i :4500
```

Sources: [README.md](README.md#L67-L72)

## 操作系统兼容性

项目支持三大桌面操作系统，不同平台有特定要求：

| 平台 | 最低版本 | 特殊要求 |
|---|---|---|
| **Linux** | Ubuntu 20.04+ / Debian 11+ | 需要 `libsecret-1-dev` 用于密钥存储（可选） |
| **macOS** | 11.0 (Big Sur)+ | 需要 Xcode 命令行工具（仅构建时） |
| **Windows** | 10 21H2+ / 11 | WSL2 环境需注意端口冲突，建议使用 23003 端口 |

**Linux 依赖**（Ubuntu/Debian）：
```bash
# 可选：密钥存储支持
sudo apt-get install libsecret-1-dev

# Electron 运行时依赖（桌面端）
sudo apt-get install libasound2-dev libatk1.0-0 libatk-bridge2.0-0 \
  libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
  libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
  libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
  libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
  libxtst6 ca-certificates fonts-liberation libappindicator3-1 libnss3 \
  lsb-release xdg-utils wget
```

Sources: [electron-builder.yml](electron-builder.yml#L1-L40)

## 可选但推荐的开发工具

以下工具非必需但能显著提升开发体验：

| 工具 | 用途 | 安装命令 |
|---|---|---|
| **oxlint** | 高性能代码检查（替代 ESLint） | `pnpm add -D oxlint` |
| **oxfmt** | 代码格式化（替代 Prettier） | `pnpm add -D oxfmt` |
| **Vitest** | 单元测试框架（已包含） | `pnpm add -D vitest` |
| **Git** | 版本控制（已包含） | 系统包管理器安装 |

**代码质量工具链**：
项目使用 [oxc](https://oxc.rs/) 生态工具替代传统 ESLint + Prettier 组合：
- **oxlint**：基于 Rust 编写，速度比 ESLint 快 10-100 倍
- **oxfmt**：一致的代码格式化，配置见 `.oxfmt.rc.json`

```bash
# 运行代码检查
pnpm lint

# 自动修复
pnpm lint --fix
```

Sources: [.oxlintrc.json](.oxlintrc.json), [.oxfmtrc.json](.oxfmtrc.json)

## 构建与打包环境

### Web 开发环境
仅需 Node.js + pnpm 即可启动开发服务器：
```bash
pnpm dev
# 访问 http://localhost:23003
```

### Electron 桌面端打包
需要额外安装 Electron 相关工具链：

**全局依赖**（electron-builder 自动安装）：
- `@electron/rebuild`：原生模块重建
- `electron`：Electron 运行时

**构建命令**：
```bash
# 开发模式（启动 Vite + Electron）
pnpm electron:start

# 生产构建
pnpm build
pnpm electron:builder
```

**平台特定代码签名**（可选）：
- **macOS**：需要 Apple Developer 证书与 `codesign` 工具
- **Windows**：需要代码签名证书（可选，用于避免 SmartScreen 警告）
- **Linux**：无需签名，但建议使用 GPG 签名

Sources: [package.json](package.json#L150-L165), [electron-builder.yml](electron-builder.yml#L80-L120)

## 网络与代理配置

在受限网络环境（如公司代理、中国网络）下，需要配置镜像源：

**pnpm 镜像源**：
```bash
# 使用淘宝镜像
pnpm config set registry https://registry.npmmirror.com

# 恢复官方源
pnpm config set registry https://registry.npmjs.org
```

**Vite 开发服务器代理**（如需代理 OpenCode API）：
`vite.config.ts` 已配置开发代理，无需额外设置。

**CORS 处理**：
开发模式下 Vite 会自动处理 CORS，生产环境需确保 OpenCode Server 配置正确的 CORS 头：
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

Sources: [vite.config.ts](vite.config.ts#L1-L50)

## 环境自检清单

在开始开发前，请逐项验证环境配置：

- [ ] **Node.js**：`node --version` 输出 ≥ v20.0.0
- [ ] **pnpm**：`pnpm --version` 输出 10.29.3 或兼容版本
- [ ] **OpenCode Server**：服务已启动并监听 51060 端口
- [ ] **端口可用性**：23003、51060、4500 端口未被占用
- [ ] **Git**：`git --version` 可正常执行
- [ ] **依赖安装**：`pnpm install` 无错误完成
- [ ] **开发服务器**：`pnpm dev` 成功启动，访问 http://localhost:23003 显示界面

**常见问题排查**：
| 问题 | 可能原因 | 解决方案 |
|---|---|---|
| `pnpm install` 失败 | 网络问题或锁文件不匹配 | 删除 `node_modules` 与 `pnpm-lock.yaml` 后重试 |
| 端口被占用 | 其他服务占用 23003/51060 | 修改 `vite.config.ts` 端口或停止冲突服务 |
| OpenCode 连接失败 | 服务器未启动或地址错误 | 确认 `OPENCODE_URL` 环境变量或设置中的服务器地址 |
| 字体显示异常 | 系统缺少等宽字体 | 安装 `fonts-jetbrains-mono` 或 `fonts-source-code-pro` |

## 环境变量引用

项目通过以下方式读取环境变量：

1. **Vite 客户端**：`import.meta.env.VITE_*` 变量
2. **Node.js 服务端**：`process.env.*` 变量
3. **Electron 主进程**：通过 `preload.cjs` 暴露受限 API

**关键环境变量**：
```bash
# OpenCode Server 地址（默认 http://localhost:51060）
VITE_OPENCODE_URL=http://localhost:51060

# 开发模式调试
VITE_DEBUG=true

# Electron 开发模式
ELECTRON_IS_DEV=true
```

Sources: [vite.config.ts](vite.config.ts#L70-L90), [electron/preload.cjs](electron/preload.cjs#L1-L30)

## 总结与后续步骤

完成环境配置后，建议按以下顺序继续学习：
- **[快速开始](2-kuai-su-kai-shi)** 了解项目启动与基本使用流程
- **[技术栈概览](5-ji-zhu-zhan-gai-lan)** 掌握项目采用的核心技术与架构决策
- **[开发与构建](4-kai-fa-yu-gou-jian)** 深入学习构建脚本与开发工作流

遇到环境问题可参考 [CHANGELOG.md](./CHANGELOG.md) 获取版本更新信息，或查阅 [RoadMap.md](./RoadMap.md) 了解项目规划。