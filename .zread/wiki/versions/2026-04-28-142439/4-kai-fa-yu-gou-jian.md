本页面涵盖项目的开发环境配置、构建系统、代码质量工具链以及 Electron 桌面端打包流程，为初学者提供从开发到发布的完整工作流指引。

## 开发环境配置
项目采用 **pnpm** 作为包管理器，版本要求 10.29.3。核心开发依赖包括 Vue 3.5.28、Vite 7.3.1 和 TypeScript 6.0.3，构成现代前端开发的黄金组合。 Electron 框架版本为 35.0.0，配合 electron-builder 26.0.0 实现跨平台桌面应用打包。代码质量工具链由 oxlint 1.47.0（静态分析）、oxfmt 0.32.0（代码格式化）和 vue-tsc 3.2.4（类型检查）组成，确保代码规范与类型安全。

开发脚本通过 npm scripts 统一管理，提供一致的命令行接口。关键命令包括开发服务器启动 (`npm run dev`)、生产构建 (`npm run build`)、测试运行 (`npm run test`)、代码检查 (`npm run lint`) 和格式化 (`npm run format`)。 Electron 专用命令 `electron:start`、`electron:build` 和 `electron:preview` 分别用于开发调试、正式打包和预览构建产物。

Sources: [package.json](package.json#L1-L82)

## 构建系统架构
Vite 构建配置定义于 `vite.config.ts`，采用模块化架构支持 Vue 单文件组件、TypeScript 类型检查和静态资源处理。构建流程分为开发模式和生产模式：开发模式利用 Vite 的快速冷启动和热模块替换 (HMR) 提供即时反馈；生产模式执行代码压缩、Tree Shaking 和资源优化，输出至 `dist` 目录供 Electron 加载。项目配置了 `prepack` 钩子，在发布前自动执行生产构建，确保分发包始终包含最新编译产物。

Sources: [vite.config.ts](vite.config.ts#L1-L200)

## 代码质量与规范
Oxlint 配置存储在 `.oxlintrc.json`，结合 `oxlint-tsgolint` 扩展实现 TypeScript 专项规则检查，覆盖代码风格、类型安全和最佳实践。代码格式化由 oxfmt 统一管理，配置位于 `.oxfmtrc.json`，确保团队协作时代码风格一致。TypeScript 编译选项在 `tsconfig.json` 中定义，启用严格模式 (`strict: true`)、路径别名映射和 Vue 专属类型支持，`vue-tsc` 在构建前执行类型检查以提前发现类型错误。

Sources: [.oxlintrc.json](.oxlintrc.json#L1-L20)  
Sources: [.oxfmtrc.json](.oxfmtrc.json#L1-L30)  
Sources: [tsconfig.json](tsconfig.json#L1-L50)

## Electron 桌面端打包
Electron 主进程入口为 `electron/main.js`，预加载脚本使用 `electron/preload.cjs` 实现安全的上下文隔离。`electron-builder.yml` 定义跨平台打包配置，支持 macOS (`.dmg`)、Windows (`.exe` 安装器) 和 Linux (`.AppImage`) 格式，包含应用图标、权限声明和代码签名设置。图标资源统一存放于 `build/` 目录，提供 `.icns` (macOS)、`.ico` (Windows)、`.png` (通用) 和 `.svg` (矢量) 格式。打包流程先执行 `vite build` 编译前端资源，再调用 electron-builder 生成可分发的安装包，macOS 专属权限配置通过 `entitlements.mac.plist` 声明。

Sources: [electron/main.js](electron/main.js#L1-L100)  
Sources: [electron-builder.yml](electron-builder.yml#L1-L40)

## 自动化 CI/CD
GitHub Actions 工作流配置于 `.github/workflows/build-electron.yml`，实现持续集成与自动化发布。工作流在代码推送至主分支时触发，依次执行依赖安装、代码检查、测试运行、生产构建和 Electron 打包，最终生成多平台安装包并上传至 GitHub Releases。该配置确保每次提交均通过质量 gates，自动化产出可验证的发布版本。

Sources: [.github/workflows/build-electron.yml](.github/workflows/build-electron.yml#L1-L60)

## 多线程渲染优化
项目利用 Web Workers 实现计算密集型任务的 off-main-thread 架构。`workers/render-worker.ts` 负责 Markdown 和代码的语法高亮渲染，`workers/sse-shared-worker.ts` 管理服务器发送事件 (SSE) 的共享连接，避免重复网络请求。这种设计将渲染和 I/O 操作从主线程隔离，提升界面响应速度和并发处理能力。

Sources: [workers/render-worker.ts](workers/render-worker.ts#L1-L100)  
Sources: [workers/sse-shared-worker.ts](workers/sse-shared-worker.ts#L1-L100)

## 桥接层与命令行工具
`vis_bridge.js` 提供 Node.js 环境下的桥接服务，`server.js` 实现本地开发服务器，两者均声明为全局命令行工具 (`npm install -g` 后可通过 `vis` 和 `vis_bridge` 直接调用)。类型定义文件 `vis_bridge.d.ts` 为 TypeScript 项目提供类型支持，确保调用桥接 API 时获得类型检查。该设计使项目既能作为独立桌面应用运行，也能以服务模式被外部工具集成。

Sources: [vis_bridge.js](vis_bridge.js#L1-L100)  
Sources: [server.js](server.js#L1-L100)

## 开发工作流总结
完整的开发工作流可概括为以下阶段：初始化环境后执行 `pnpm install` 安装依赖，`npm run dev` 启动 Vite 开发服务器预览界面，开发过程中使用 `npm run lint` 和 `npm run test` 保证代码质量，功能完成后 `npm run build` 生成生产构建，最终通过 `npm run electron:build` 打包桌面应用。如需调试 Electron 环境，`npm run electron:start` 可直接启动带开发者工具的桌面窗口。

---

**建议的后续阅读**：
- [项目目录结构](20-xiang-mu-mu-lu-jie-gou) 了解代码组织方式
- [技术栈概览](5-ji-zhu-zhan-gai-lan) 深入框架选型与版本兼容性
- [Electron 桌面端集成](7-electron-zhuo-mian-duan-ji-cheng) 掌握主进程与渲染进程通信
- [构建配置](28-gou-jian-pei-zhi) 查看 Vite 与 electron-builder 详细配置
- [GitHub Actions 自动化](30-github-actions-zi-dong-hua) 了解 CI/CD 完整流程