本页提供完整的开发环境初始化指南，涵盖工具链配置、依赖安装、开发服务器启动以及代码规范设置。目标受众为具备基础前端开发经验的中间层次开发者。

## 环境要求与前置条件
系统需要安装 Node.js ≥ 18.16.0（基于 Vite 官方要求及 package.json 中的 engines 约束）和 pnpm ≥ 8（通过 package.json 的 packageManager 字段指定）。项目采用 **TypeScript 5** 作为静态类型检查层，**Vite 5** 作为构建与开发服务器核心，**Vue 3** 作为 UI 框架。代码质量保障工具链包括 ESLint 用于静态分析、Prettier 用于代码格式化、Vitest 用于单元测试。

## 技术栈版本矩阵

| 组件 | 版本要求 | 作用 |
|------|---------|------|
| Node.js | ≥ 18.16.0 | JavaScript 运行时 |
| pnpm | ≥ 8.0.0 | 包管理器（workspace 支持） |
| Vite | 5.x | 构建工具与开发服务器 |
| Vue | 3.x | UI 框架 |
| TypeScript | 5.x | 类型系统 |

## 安装流程

### 1. 克隆仓库
```bash
git clone <repository-url>
cd vis
```

### 2. 依赖安装
项目使用 pnpm workspace 管理 monorepo 结构（pnpm-workspace.yaml 定义），安装命令会自动链接内部依赖包：
```bash
pnpm install
```
该命令读取 package.json 中的 dependencies 与 devDependencies，并生成 pnpm-lock.yaml 锁定的依赖树。

### 3. 开发服务器启动
```bash
pnpm dev
```
Vite 开发服务器在 http://localhost:5173 启动（可通过 vite.config.ts 的 server.port 配置覆盖）。支持热模块替换（HMR）实现实时预览。

### 4. 生产构建
```bash
pnpm build
```
构建产物输出至 `dist/` 目录，采用 Vite 的 rollup 选项进行代码分割与压缩。

## 代码规范与格式化
项目配置了 ESLint 与 Prettier 双工具链，确保代码风格一致性：

- **ESLint 配置**：`.oxlintrc.json` 定义 lint 规则（实际为 oxlint 配置，兼容 ESLint 规范）
- **Prettier 配置**：`.oxfmtrc.json` 定义格式化规则（覆盖缩进、引号、尾随逗号等）
- **TypeScript 配置**：`tsconfig.json` 设置 compilerOptions（strict: true、target: ES2020、module: ESNext）

执行格式化：
```bash
pnpm format
```
执行 lint：
```bash
pnpm lint
```

## 开发工具链配置
### Vite 配置要点
`vite.config.ts` 包含关键配置：
- **别名映射**：`@` 指向 `app/` 目录，简化模块导入
- **CSS 处理**：集成 Tailwind CSS（postcss.config.mjs 配置）
- **Worker 支持**：配置 Web Worker 构建选项（用于渲染worker与SSE共享worker）
- **开发服务器选项**：端口、代理、CORS 设置

### 环境变量
Vite 支持 `.env` 文件加载，开发环境使用 `.env.development`，生产环境使用 `.env.production`。敏感配置通过 `VITE_` 前缀暴露给客户端代码。

### 国际化配置
`app/i18n` 目录包含多语言资源（en.ts、zh-CN.ts），通过 `useI18n` composable 在组件中访问。开发时可切换语言测试。

## 测试环境
项目使用 Vitest 作为测试框架，配置文件集成在 vite.config.ts 中。测试文件位于各模块同名 `.test.ts` 文件（如 `useSettings.test.ts`、`sseConnection.test.ts`）。运行测试：
```bash
pnpm test
```
支持 watch 模式与覆盖率报告生成。

## 目录结构规范
```
app/                    # 前端应用源码
  components/          # Vue 组件
  composables/         # 组合式函数（逻辑复用）
  i18n/                # 国际化核心
  styles/              # 全局样式（Tailwind）
  types/               # TypeScript 类型定义
  utils/               # 工具函数库
  workers/             # Web Worker 脚本
docs/                  # 文档目录
  tools/               # 工具定义文档
server.js              # 开发服务器入口（可选后端模拟）
```

## 常见问题排查

| 问题现象 | 解决方案 |
|---------|---------|
| 依赖安装失败 | 清除 pnpm 缓存 `pnpm store prune` 后重试 |
| 端口占用 | 修改 `vite.config.ts` 的 `server.port` 为其他端口 |
| 类型错误 | 检查 `tsconfig.json` 的 `paths` 配置与 Vite 别名一致 |
| 样式未生效 | 确认 `postcss.config.mjs` 包含 Tailwind 插件且 `app/styles/tailwind.css` 被正确引入 |

## 调试与开发辅助
- **Vue Devtools**：浏览器扩展，可检查组件状态与响应式数据
- **Source Map**：Vite 默认生成 source map，支持断点调试
- **日志级别**：通过 `VITE_DEBUG` 环境变量控制调试输出

## 下一步建议
掌握开发环境配置后，建议继续阅读：
- [系统架构概览](5-xi-tong-jia-gou-gai-lan) 理解整体设计
- [浮动窗口管理系统](6-fu-dong-chuang-kou-guan-li-xi-tong) 学习核心交互模式
- [SSE 实时通信机制](9-sse-shi-shi-tong-xin-ji-zhi) 了解数据流架构