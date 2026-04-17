本页面提供完整的本地开发环境搭建和生产部署指南，涵盖依赖安装、开发服务器启动、生产构建以及 OpenCode 服务器配置。目标读者为具备基础命令行操作的开发者，预计阅读时间 5 分钟。

## 系统要求与前置条件
在开始安装前，请确保系统已安装以下组件：
- **Node.js**: 版本 ≥ 18.0.0（推荐使用最新 LTS 版本）
- **包管理器**: pnpm ≥ 10.0.0（项目使用 pnpm-workspace.yaml 管理 Monorepo）
- **Git**: 用于版本控制与 Git 修订号注入

项目采用 Vite 作为构建工具，结合 Vue 3 框架，TypeScript 负责类型检查。构建过程通过 Rollup 进行代码分割，并根据依赖库自动分块以优化加载性能 [vite.config.ts](vite.config.ts#L17-L38)。

| 组件 | 版本要求 | 用途 |
|------|----------|------|
| Node.js | ≥ 18.0.0 | 运行服务器与构建工具 |
| pnpm | ≥ 10.0.0 | 依赖管理 |
| Vue 3 | ^3.5.28 | 前端框架 |
| Vite | ^7.3.1 | 构建与开发服务器 |

## 获取源代码
由于该项目未发布至 npm  registry，唯一获取方式是克隆 Git 仓库。推荐使用 HTTPS 方式克隆：

```bash
git clone https://github.com/qiyuanhuakai/opencode-visualizer-cn
cd opencode-visualizer-cn
```

项目根目录包含以下关键文件 [README.md](README.md#L1)：
- `package.json`: 定义依赖与脚本命令
- `pnpm-workspace.yaml`: 工作区配置（当前为单包结构）
- `vite.config.ts`: Vite 构建配置，包含自定义 chunk 分割策略
- `server.js`: 生产环境 Node 服务器入口
- `app/`: 前端源代码目录（Vite root 指向此处）

## 依赖安装
使用 pnpm 安装项目依赖。由于项目包含开发依赖与生产依赖，安装过程将自动解析依赖树并下载至 `node_modules`：

```bash
pnpm install
```

首次安装可能需要较长时间，因为需要下载 xterm.js、shiki（语法高亮）、vue-i18n 等体积较大的依赖包。安装完成后，可通过以下命令验证依赖完整性 [package.json](package.json#L40-L62)：

```bash
pnpm lint   # 运行代码检查（可选）
```

## 开发模式运行
开发模式下，Vite 启动热重载开发服务器，监听 `app/` 目录变化并实时更新浏览器。运行以下命令启动开发环境：

```bash
pnpm dev
```

默认情况下，开发服务器监听 `http://localhost:5173`（Vite 默认端口）。此时前端已就绪，但**尚未连接 OpenCode API 服务器**。若需与后端通信，需在单独终端启动 OpenCode 服务：

```bash
opencode serve --cors http://localhost:5173
```

CORS 配置允许开发服务器跨域访问 OpenCode API。若使用配置文件方式，可在 `~/.config/opencode/opencode.json` 中添加 CORS 条目 [README.md](README.md#L26-L33)。

## 生产构建
生产构建将前端资源打包至 `dist/` 目录，并应用代码压缩、静态资源哈希等优化。构建命令如下：

```bash
pnpm build
```

构建过程执行以下步骤 [vite.config.ts](vite.config.ts#L17-L38)：
1. 读取 `app/` 为源目录，`../dist` 为输出目录
2. 根据 `manualChunks` 策略将依赖分割为多个 chunk：
   - `vendor-vue`: Vue 运行时
   - `vendor-vue-i18n`: 国际化模块
   - `vendor-terminal`: xterm.js 终端相关
   - `vendor-ui`: 图标与 UI 组件库
   - `vendor-utils`: 工具库（date-fns、lodash 等）
3. 注入 Git 短修订号作为全局变量 `__GIT_REVISION__`
4. 生成静态资源（HTML、JS、CSS）供 Node 服务器托管

构建输出位于 `dist/` 目录，结构如下：
```
dist/
├── index.html
├── assets/
│   ├── vendor-*.js
│   ├── app-*.js
│   └── style-*.css
```

## 本地服务器启动
生产环境需使用 Node.js 运行 `server.js`，该文件基于 Hono 框架创建静态文件服务器，并处理 SSE 连接与 API 代理。启动命令：

```bash
node server.js
```

默认端口为 **3000**（可在 `server.js` 中修改）。服务器启动后，访问 `http://localhost:3000` 即可使用完整功能。若需后台持久运行，建议使用 `nohup` 或进程管理器（如 pm2）：

```bash
nohup node server.js 2>&1 &
```

此时，前端已连接本地 OpenCode 实例（需 OpenCode 服务在同一网络可达）。若 OpenCode 运行于其他主机或端口，请在界面中通过地址栏输入完整 API 地址进行连接 [README.md](README.md#L57-L60)。

## OpenCode 服务器配置
Vis 依赖 OpenCode 提供的 SSE 与 REST API。若 OpenCode 未启动或 CORS 未配置，界面将显示连接错误。配置 OpenCode 的方法：

**命令行启动**（推荐用于开发）：
```bash
opencode serve --cors http://localhost:3000
```

**配置文件方式**（持久化配置），编辑 `~/.config/opencode/opencode.json`：
```json
{
  "$schema": "https://opencode.ai/config.json",
  "server": {
    "cors": ["http://localhost:3000"]
  }
}
```

随后正常启动 `opencode serve` 即可 [README.md](README.md#L26-L33)。若遇到浏览器安全策略阻止本地连接，请检查 OpenCode 日志确认 CORS 头是否正确设置。

## 故障排除
| 问题 | 可能原因 | 解决方案 |
|------|----------|----------|
| `node server.js` 报错 "EADDRINUSE" | 端口 3000 被占用 | 修改 `server.js` 中的 `PORT` 常量，或停止占用进程 |
| 页面无法连接 OpenCode | OpenCode 未启动或 CORS 未配置 | 检查 OpenCode 是否运行，确认 CORS 包含当前前端地址 |
| 构建失败 "Cannot find module" | 依赖未安装或版本冲突 | 删除 `node_modules` 与 `pnpm-lock.yaml`，重新运行 `pnpm install` |
| 开发服务器端口冲突 | 5173 端口被占用 | 运行 `pnpm dev -- --port 5174` 指定其他端口 |

## 下一步
完成安装配置后，建议继续阅读以下文档以深入理解系统：
- [快速开始](2-kuai-su-kai-shi)：了解界面布局与基本操作
- [基本使用](4-ji-ben-shi-yong)：学习会话管理、工具窗口与终端使用
- [SSE 实时通信机制](9-sse-shi-shi-tong-xin-ji-zhi)：理解前端与 OpenCode 的数据流