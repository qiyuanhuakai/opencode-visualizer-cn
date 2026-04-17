本文档详细介绍 Vis 项目的构建系统配置、打包优化策略以及部署方案，面向需要在生产环境部署或进行高级构建定制的开发者。核心内容涵盖 Vite 构建配置、代码分块策略、开发工作流以及作为 CLI 工具的独立服务器部署模式。

## 构建系统架构概览
Vis 采用 Vite 7 作为现代前端构建工具，配合 Vue 3 的 SFC（单文件组件）编译能力。构建配置位于 [vite.config.ts](vite.config.ts) 中，定义了源代码目录、输出目录、代码分割策略和测试环境等关键参数。项目采用 pnpm 作为包管理器，版本锁定在 pnpm@10.29.3，通过 [pnpm-workspace.yaml](pnpm-workspace.yaml) 支持工作区协作。

```
┌─────────────────┐
│  package.json   │  ← 脚本定义与依赖管理
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  vite.config.ts │────▶│   Vite 7 Build  │
└────────┬────────┘     └────────┬────────┘
         │                      │
         ▼                      ▼
┌─────────────────┐     ┌─────────────────┐
│   app/ (root)   │     │  dist/ (output) │
│   main.ts       │     │  assets/        │
│   components/   │     │  index.html     │
└─────────────────┘     └─────────────────┘
```

## Vite 构建配置详解
构建配置通过 [vite.config.ts](vite.config.ts#L1-L55) 明确定义了几个关键维度。首先，`root: 'app'` 将应用源代码目录设为 `app/`，所有模块解析和资源加载均相对于该目录；`base: './'` 使用相对路径作为资源基准，确保部署到任意子路径时资源引用正确。其次，`outDir: '../dist'` 将构建产物输出到项目根目录的 `dist/` 文件夹，配合 `emptyOutDir: true` 在每次构建前清空输出目录，避免残留文件导致的问题。

Git 版本哈希被注入为编译时常量 `__GIT_REVISION__`，通过 `execSync('git rev-parse --short HEAD')` 获取当前提交的短 SHA，使生产环境能够追踪构建版本。Worker 脚本采用 ES 模块格式（`worker: { format: 'es' }`），与现代浏览器原生模块加载兼容。

代码分块策略（chunk splitting）在 Rollup 的 `manualChunks` 回调中实现，按第三方库的归属自动分配至不同 vendor chunk：

| Chunk 名称 | 包含依赖 | 设计目的 |
|-----------|---------|---------|
| `vendor-vue` | `vue`, `vue-i18n` | 核心框架与国际化 |
| `vendor-ui` | `@headlessui`, `@iconify` | UI 组件库与图标 |
| `vendor-terminal` | `@xterm` | 终端模拟器 |
| `vendor-utils` | `marked`, `date-fns`, `lodash` | 通用工具库 |

这种分块策略确保了框架和 UI 库的长期缓存，同时将大型终端库隔离，避免影响首屏加载。`chunkSizeWarningLimit: 1000` 将分块大小警告阈值设置为 1KB，有助于监控包体积异常增长。

Sources: [vite.config.ts](vite.config.ts#L1-L55)

## 开发工作流脚本
[package.json](package.json#L17-L26) 中定义了完整的开发脚本矩阵。`pnpm dev` 启动 Vite 开发服务器，启用 HMR（热模块替换）；`pnpm build` 执行生产构建；`pnpm test` 运行 Vitest 单元测试（环境为 `happy-dom`，一个轻量级 DOM 模拟器）。`pnpm lint` 集成 Oxlint 进行静态检查，并调用 `vue-tsc` 进行 TypeScript 类型验证（`--noEmit` 仅检查不输出）。`pnpm format` 使用 Oxfmt 统一代码格式。

特别地，`prepack` 钩子在 `pnpm pack` 或发布前自动触发 `vite build`，确保打包的 npm 包包含最新构建产物。`bin.vis` 字段声明 `server.js` 为可执行入口，使项目能以 CLI 方式独立运行。

Sources: [package.json](package.json#L17-L26)

## TypeScript 编译配置
[tsconfig.json](tsconfig.json) 配置了 TypeScript 编译选项，关键设置包括 `target: "ES2022"` 使用现代 JavaScript 特性，`module: "ESNext"` 配合 Vite 的 ESM 输出，以及 `moduleResolution: "Bundler"` 适配打包工具模块解析。`strict: true` 启用严格类型检查，`jsx: "preserve"` 保留 Vue 模板语法。路径别名未显式配置，依赖 Vite 的 `@` 别名（默认指向 `app/`）。

Sources: [tsconfig.json](tsconfig.json)

## PostCSS 与 Tailwind 配置
[postcss.config.mjs](postcss.config.mjs) 集成 Tailwind CSS v4 的 PostCSS 处理器，配合 `@tailwindcss/postcss` 和 `@tailwindcss/typography` 插件支持排版样式。样式入口位于 [app/styles/tailwind.css](app/styles/tailwind.css)，通过 `@import "tailwindcss"` 引入 Tailwind v4 的新语法。Autoprefixer 配置确保浏览器前缀自动添加。

Sources: [postcss.config.mjs](postcss.config.mjs)

## 生产部署方案
Vis 支持两种主要部署模式：**静态文件托管**与**独立服务器模式**。静态部署时，运行 `pnpm build` 生成 `dist/` 目录，将该目录部署至任何静态文件服务器（如 Nginx、GitHub Pages、Vercel）。由于 `base: './'` 配置，资源使用相对路径，无需调整即可在任意子路径运行。

独立服务器模式通过 `server.js` 实现，该文件同时作为 Node.js 可执行入口（`bin.vis`）。它使用 Hono 框架构建轻量级 HTTP 服务器，集成 SSE 实时通信与静态文件服务。启动方式为 `node server.js` 或全局安装后执行 `vis` 命令。服务器同时处理 API 请求、WebSocket 连接和前端资源分发，适合本地开发或私有化部署。

Sources: [package.json](package.json#L13-L14), [server.js](server.js)

## 环境变量与构建时注入
除 Git Revision 外，Vite 配置未显式定义其他环境变量注入。如需注入自定义变量，可扩展 `define` 字段，例如 `process.env.NODE_ENV` 已由 Vite 自动替换为 `"production"` 或 `"development"`。跨域、代理等开发环境设置可通过 `.env` 文件管理（当前仓库未使用）。

## 测试架构配置
Vitest 配置嵌入在 [vite.config.ts](vite.config.ts#L45-L52) 中，指定测试文件匹配模式为 `**/*.test.ts`，测试环境为 `happy-dom`（无需浏览器即可模拟 DOM API），`globals: false` 要求显式导入断言函数，符合严格 TypeScript 项目规范。测试覆盖率未启用，可根据需要添加 `coverage` 配置块。

Sources: [vite.config.ts](vite.config.ts#L45-L52)

## 依赖管理与版本策略
项目依赖分为运行时（`dependencies`）与开发时（`devDependencies`）。运行时仅包含 Hono（Web 框架与服务器端组件）和 Vue I18n（国际化）；其余均为构建、测试或 UI 组件相关开发依赖。`packageManager` 字段锁定 pnpm 版本，确保 CI/CD 环境一致性。[pnpm-workspace.yaml](pnpm-workspace.yaml) 声明工作区协议，支持 mono-repo 管理（当前仅单一包）。

Sources: [package.json](package.json#L28-L61), [pnpm-workspace.yaml](pnpm-workspace.yaml)

## 构建产物分析
生产构建输出结构预期如下：
```
dist/
├── assets/
│   ├── index-xxxx.css      # 主样式包（包含 Tailwind 与自定义 CSS）
│   ├── index-xxxx.js       # 主应用脚本
│   ├── vendor-vue-xxxx.js  # Vue 生态分块
│   ├── vendor-ui-xxxx.js   # UI 库分块
│   ├── vendor-terminal-xxxx.js  # 终端库分块
│   └── vendor-utils-xxxx.js     # 工具库分块
└── index.html              # 注入资源引用的 HTML 入口
```
所有资源文件名包含哈希，实现长期缓存。分块策略确保核心框架变更时仅影响 `vendor-vue`，UI 组件更新仅影响 `vendor-ui`，提升缓存命中率。

## 常见构建问题排查
若构建失败，首先检查 Node.js 版本（推荐 >= 18）与 pnpm 版本（与 `packageManager` 字段一致）。Git 命令失败通常因在非 Git 仓库目录执行构建，可修改 [vite.config.ts](vite.config.ts#L6) 添加回退值或设置 `VITE_GIT_REVISION` 环境变量。TypeScript 类型错误由 `vue-tsc` 在 lint 阶段捕获，需修复类型问题方可通过 CI。

Sources: [vite.config.ts](vite.config.ts#L6)

## 下一步建议
构建配置与开发环境搭建紧密关联，建议继续阅读 [开发环境搭建](23-kai-fa-huan-jing-da-jian) 了解本地开发环境配置细节。如需深入测试策略，参考 [测试策略与工具](24-ce-shi-ce-lue-yu-gong-ju)。部署后，可进一步研究 [SSE 实时通信机制](9-sse-shi-shi-tong-xin-ji-zhi) 与 [REST API 完整参考](26-rest-api-wan-zheng-can-kao) 以优化服务端集成。