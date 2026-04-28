构建配置页面概述了项目从开发到打包的完整构建管线，包括 Vite 开发构建、TypeScript 编译、Electron 桌面应用打包以及多平台发布配置。本页面涵盖核心构建工具链、配置文件结构、平台特定构建参数以及开发者可用的构建命令。

## 构建工具链架构

项目采用模块化的构建工具链组合：**Vite** 负责前端资源构建与开发服务器，**electron-builder** 处理桌面应用打包，**TypeScript** 提供类型检查，**vitest** 运行单元测试。构建流程以 Vite 为核心枢纽，前端代码编译为 `dist` 目录后由 electron-builder 打包为各平台可执行文件。

构建管线呈现分层结构：第一层为开发时构建（`vite dev`），提供热重载与源映射支持；第二层为生产构建（`vite build`），进行代码压缩、Tree-shaking 与资源优化；第三层为桌面打包（`electron-builder`），将 Web 资源与 Electron 运行时整合为平台原生安装包。各层解耦设计允许独立调试与优化。

## 核心配置文件详解

### package.json 构建脚本

构建入口定义于 [package.json](package.json#L24-L35)，提供六个核心脚本命令：

| 脚本名 | 执行流程 | 输出产物 | 使用场景 |
|--------|----------|----------|----------|
| `dev` | 启动 Vite 开发服务器 | 内存中的开发构建 | 日常开发调试 |
| `build` | 执行 Vite 生产构建 | `dist/` 目录静态资源 | 预发布测试 |
| `test` | 运行 vitest 单元测试 | 测试报告输出 | 质量保证 |
| `electron:start` | 启动 Electron 开发环境 | 开发调试窗口 | 桌面端开发 |
| `electron:build` | 完整打包流程 | 平台安装包（`dist-electron/`） | 正式发布 |
| `electron:preview` | 打包但不签名 | 未签名安装包 | 本地验证 |

`prepack` 钩子确保 npm 发布前自动执行生产构建，`postinstall` 在依赖安装后运行 `electron-builder install-app-deps` 编译原生模块。Sources: [package.json](package.json#L24-L35)

### Vite 构建配置

Vite 配置位于 [vite.config.ts](vite.config.ts#L1-L69)，采用扁平化结构定义开发、构建与测试环境：

```typescript
// 关键配置摘要
export default defineConfig({
  base: './',                    // 相对路径基础 URL（适配 Electron 文件协议）
  root: 'app',                   // 项目根目录为 app 子目录
  plugins: [vue()],              // Vue 3 单文件组件支持
  resolve: {                     // Node 内置模块 polyfill 映射
    alias: {
      buffer: 'buffer/',
      fs: path.resolve(__dirname, 'app/utils/node-polyfill.ts'),
      path: path.resolve(__dirname, 'app/utils/node-polyfill.ts'),
      crypto: path.resolve(__dirname, 'app/utils/node-polyfill.ts'),
    },
  },
  build: {
    outDir: '../dist',           // 输出到项目根级 dist 目录
    emptyOutDir: true,           // 每次构建前清空输出目录
    chunkSizeWarningLimit: 1000, // 区块大小警告阈值（KB）
    rollupOptions: {             // 手动代码分割策略
      output: {
        manualChunks(id) {
          // 按第三方库分组：vue-i18n、vue、UI组件、终端、工具库
        }
      }
    }
  }
})
```

`__GIT_REVISION__` 编译时常量通过 `execSync` 注入 Git 提交短哈希，实现版本追踪。Sources: [vite.config.ts](vite.config.ts#L1-L20)

### Electron Builder 打包配置

[electron-builder.yml](electron-builder.yml#L1-L106) 声明式配置多平台打包参数，采用 YAML 结构分层定义：

**通用配置**：`appId` 设置反向域名标识符，`directories` 定义 `dist-electron` 输出目录与 `build` 资源目录，`files` 白名单机制包含 `dist`、`electron` 与 `package.json` 同时排除 `.git`、`docs` 等开发文件。

**ASAR 压缩**：`asar: true` 启用 Electron 资源归档，`asarUnpack: ["**/*.node"]` 解包原生 Node 模块（`.node` 文件）以保留动态链接库加载能力。

**macOS 配置**：生成 DMG 安装镜像与 ZIP 压缩包，支持 x64 与 arm64 双架构，启用 Hardened Runtime 安全模式但关闭 Gatekeeper 评估（开发者分发场景），使用 `build/entitlements.mac.plist` 配置文件权限。

**Windows 配置**：生成 NSIS 安装器，支持 x64/arm64，配置桌面与开始菜单快捷方式，保留用户数据目录不随卸载删除。

**Linux 配置**：提供 AppImage 便携格式与 DEB 系统包格式，仅支持 x64 架构，设置应用分类为开发工具。

**发布扩展**：`nsis` 与 `dmg` 节细化安装器 UI 布局，Windows 允许自定义安装目录，macOS 创建 Applications 文件夹链接。Sources: [electron-builder.yml](electron-builder.yml#L1-L106)

### TypeScript 编译配置

[tsconfig.json](tsconfig.json#L1-L19) 严格模式配置确保类型安全：`target` 与 `module` 设为 `ESNext` 兼容现代 JS 运行时，`moduleResolution: bundler` 适配 Vite 打包器模式，`strict: true` 启用全部类型检查，`noUnusedLocals` 与 `noUnusedParameters` 强制代码整洁性。

`include` 数组限定编译范围为 `app` 源码目录、`server` 服务端代码与 `vite.config.ts` 构建配置本身，排除 `node_modules` 与 `dist` 输出目录。Sources: [tsconfig.json](tsconfig.json#L1-L19)

## 构建产物结构

生产构建产出分层组织：`dist/` 包含静态资源（JS 包、CSS、字体、图片），`dist-electron/` 包含平台安装包，根级保留 `vis_bridge.js` 与 `vis_bridge.d.ts` CLI 桥接器。

Vite 代码分割策略将第三方库分组打包：`vendor-vue-i18n.js` 国际化库、`vendor-vue.js` Vue 运行时、`vendor-ui.js` HeadlessUI 与 Iconify 组件、`vendor-terminal.js` xterm.js 终端模拟器、`vendor-utils.js` 通用工具库（marked、date-fns、lodash）。分割策略减少首屏加载体积并利用浏览器缓存。Sources: [vite.config.ts](vite.config.ts#L35-L69)

## 平台特定构建参数

各平台构建参数差异通过 electron-builder 配置隔离：

**macOS 双架构**：`target` 数组分别指定 `dmg` 与 `zip` 格式，`arch` 包含 `x64` 与 `arm64`，artifactName 模板 `${version}-${arch}-MacOS.${ext}` 生成版本化文件名。

**Windows 安装器**：`nsis` 节配置 `oneClick: false` 启用向导模式，`allowToChangeInstallationDirectory: true` 允许自定义路径，`createDesktopShortcut` 创建桌面图标。

**Linux 打包**：`AppImage` 提供无需安装的便携运行，`deb` 包支持 `apt` 包管理器，`executableName: vis` 设置命令行可执行文件名。

所有平台共享 `asar: true` 压缩策略与 `**/*.node` 解包规则，确保原生模块在归档后仍可动态加载。Sources: [electron-builder.yml](electron-builder.yml#L42-L106)

## 构建环境变量与常量

`__GIT_REVISION__` 是唯一的编译时常量，通过 Node `child_process.execSync` 执行 `git rev-parse --short HEAD` 获取当前提交短哈希，在构建时通过 `define` 选项注入全局常量。该机制支持开发调试时显示版本标识，生产环境用于远程诊断与错误上报。

`base: './'` 配置适配 Electron 的 `file://` 协议加载场景，相对路径确保资源在打包后的嵌套目录结构中正确解析。Sources: [vite.config.ts](vite.config.ts#L1-L20)

## 开发构建工作流

开发时构建流程：`pnpm dev` 启动 Vite 开发服务器（127.0.0.1:5173），启用 HMR（热模块替换）与源映射，`electron:start` 脚本基于 `scripts/electron-start.mjs` 启动 Electron 主进程并连接开发服务器。`strictPort: true` 防止端口冲突导致的并发问题。

生产构建流程：`pnpm build` 触发 Vite 构建生成 `dist/` 静态资源，`electron:build` 继续调用 electron-builder 读取 `dist` 与 `electron` 目录生成安装包，`asar` 压缩与平台签名根据配置自动完成。Sources: [package.json](package.json#L24-L35), [vite.config.ts](vite.config.ts#L25-L33)

## 构建优化策略

Vite 配置中 `manualChunks` 实现细粒度代码分割：Vue 生态（`vue`、`vue-i18n`）分离为独立区块，UI 组件库（`@headlessui`、`@iconify`）聚合为 `vendor-ui`，`@xterm` 终端库单独打包避免与其他模块耦合。分割策略平衡首屏加载与缓存复用。

`chunkSizeWarningLimit: 1000` 设置 1MB 警告阈值，超过此阈值的区块需审视是否过度聚合。`emptyOutDir: true` 确保构建输出清洁，避免残留文件导致版本不一致。Sources: [vite.config.ts](vite.config.ts#L35-L69)

## 构建命令速查

| 命令 | 触发动作 | 前置条件 | 输出产物 |
|------|----------|----------|----------|
| `pnpm dev` | Vite 开发服务器 | Node.js 环境 | 开发服务器 |
| `pnpm build` | 生产构建 | 依赖已安装 | `dist/` |
| `pnpm test` | 单元测试 | 测试文件存在 | 测试报告 |
| `pnpm electron:start` | 开发模式 Electron | `pnpm dev` 运行中 | 调试窗口 |
| `pnpm electron:build` | 完整打包 | `pnpm build` 完成 | `dist-electron/*` |
| `pnpm electron:preview` | 预览打包（未签名） | `pnpm build` 完成 | 未签名安装包 |

所有脚本依赖 `package.json` 声明，执行前需运行 `pnpm install` 安装依赖并触发 `postinstall` 原生模块编译。Sources: [package.json](package.json#L24-L35)

## 下一步阅读建议

构建配置与多个架构模块紧密关联：**[Electron 桌面端集成](7-electron-zhuo-mian-duan-ji-cheng)** 讲解主进程与渲染进程通信机制，**[开发指南 - 项目目录结构](20-xiang-mu-mu-lu-jie-gou)** 展示源代码组织方式，**[GitHub Actions 自动化](30-github-actions-zi-dong-hua)** 说明 CI/CD 流水线如何调用上述构建命令。