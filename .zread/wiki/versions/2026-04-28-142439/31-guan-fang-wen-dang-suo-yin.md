本文档作为 OpenCode Visualizer CN 的官方文档导航中心，为开发者提供完整的文档体系结构概览与快速访问入口。通过系统化的分类索引，帮助初级开发者快速定位所需技术信息，支持从入门到精通的渐进式学习路径。

## 文档体系架构

项目文档采用模块化分层设计，覆盖从快速入门到深度定制的完整知识链。文档体系分为五大核心模块：入门指南提供项目认知基础；核心架构解析技术栈与设计决策；功能模块详解交互特性；开发指南指导源码级工作；测试与部署确保交付质量。

下表展示了完整的文档分类与对应页面：

| 分类 | 页面名称 | 标识符 | 核心内容 |
|------|---------|--------|---------|
| **入门指南** | 项目概述 | 1-xiang-mu-gai-shu | 项目背景、fork 来源、核心改进方向 |
| | 快速开始 | 2-kuai-su-kai-shi | 安装步骤、开发启动、基础配置 |
| | 环境要求 | 3-huan-jing-yao-qiu | Node.js、pnpm、OpenCode Server 依赖 |
| | 开发与构建 | 4-kai-fa-yu-gou-jian | Web 开发、Electron 打包命令 |
| **核心架构** | 技术栈概览 | 5-ji-zhu-zhan-gai-lan | Vue 3、Vite、Tailwind、xterm.js 等技术选型 |
| | 前端架构设计 | 6-qian-duan-jia-gou-she-ji | 组件分层、状态管理、Composables 模式 |
| | Electron 桌面端集成 | 7-electron-zhuo-mian-duan-ji-cheng | 主进程、预加载脚本、安全沙箱 |
| | 后端服务与 API | 8-hou-duan-fu-wu-yu-api | Hono 服务、SSE 事件流、vis_bridge |
| | vis_bridge 桥接器 | 9-vis_bridge-qiao-jie-qi | Codex JSON-RPC 转发协议 |
| **功能模块** | 用户界面组件 | 10-yong-hu-jie-mian-zu-jian | SidePanel、ThreadBlock、Dropdown 等组件 |
| | 国际化 (i18n) 系统 | 11-guo-ji-hua-i18n-xi-tong | 多语言框架、locale 文件、语言切换 |
| | 字体与主题管理 | 12-zi-ti-yu-zhu-ti-guan-li | 字体发现、主题注入、区域着色 |
| | 会话管理与批量操作 | 13-hui-hua-guan-li-yu-pi-liang-cao-zuo | 会话树、Pin 功能、归档恢复 |
| | 悬浮窗与 Dock 栏 | 14-xuan-fu-chuang-yu-dock-lan | 浮动窗口系统、最小化管理 |
| | 状态监控面板 | 15-zhuang-tai-jian-kong-mian-ban | Token 消耗、服务状态、MCP 控制 |
| | 代码行评论功能 | 16-dai-ma-xing-ping-lun-gong-neng | 范围选择、评论附加、Diff 集成 |
| | 供应商与模型管理 | 17-gong-ying-shang-yu-mo-xing-guan-li | 模型启用/禁用、自定义提供商 |
| | 嵌入式终端 | 18-qian-ru-shi-zhong-duan | xterm.js 集成、Shell 交互 |
| | 代码与 Diff 查看器 | 19-dai-ma-yu-diff-cha-kan-qi | Shiki 高亮、diff 对比、懒加载 |
| **开发指南** | 项目目录结构 | 20-xiang-mu-mu-lu-jie-gou | app/、docs/、utils/ 等目录说明 |
| | Composables 可组合函数 | 21-composables-ke-zu-he-han-shu | useCodexApi、useMessages 等逻辑复用 |
| | 工具函数库 | 22-gong-ju-han-shu-ku | formatters、theme、path 等通用工具 |
| | 类型定义 | 23-lei-xing-ding-yi | message.ts、sse.ts、worker-state.ts |
| | 样式系统 | 24-yang-shi-xi-tong | Tailwind CSS v4、主题令牌、区域样式 |
| | Web Workers 多线程 | 25-web-workers-duo-xian-cheng | render-worker、sse-shared-worker |
| | 性能优化策略 | 26-xing-neng-you-hua-ce-lue | 懒加载、虚拟滚动、后台 Hydration |
| **测试与部署** | 测试框架配置 | 27-ce-shi-kuang-jia-pei-zhi | Vitest 配置、单元测试示例 |
| | 构建配置 | 28-gou-jian-pei-zhi | Vite 配置、Electron Builder 选项 |
| | Electron 打包与分发 | 29-electron-da-bao-yu-fen-fa | 各平台安装包生成、代码签名 |
| | GitHub Actions 自动化 | 30-github-actions-zi-dong-hua | CI/CD 流水线、自动化构建 |
| **文档资源** | 官方文档索引 | 31-guan-fang-wen-dang-suo-yin | 本文档，提供全文档导航 |
| | API 参考 | 32-api-can-kao | vis_bridge API、Composables 接口 |
| | 工具命令说明 | 33-gong-ju-ming-ling-shuo-ming | apply_patch、edit、read 等工具 |
| | SSE 与事件流 | 34-sse-yu-shi-jian-liu | Server-Sent Events 协议实现 |
| | 窗口架构设计 | 35-chuang-kou-jia-gou-she-ji | 悬浮窗生命周期、渲染管线 |

Sources: [README.md](./README.md#L1-L100)

## 文档导航路径建议

针对不同学习目标的读者，建议按以下路径系统阅读：

**前端开发者**应优先阅读「技术栈概览」→「前端架构设计」→「Composables 可组合函数」→「用户界面组件」，建立完整的前端知识视图。

**后端集成工程师**应从「后端服务与 API」→「SSE 与事件流」→「vis_bridge 桥接器」→「API 参考」入手，掌握服务通信机制。

**桌面端打包人员**需重点研读「Electron 桌面端集成」→「构建配置」→「Electron 打包与分发」，理解跨平台发布流程。

**新功能贡献者**建议先浏览「项目目录结构」定位代码位置，再阅读对应「功能模块」页面了解业务逻辑。

Sources: [docs/](./docs#L1-L20)

## 文档编写规范

所有文档页面遵循 Diátaxis 方法论（解释、教程、操作指南、参考）与 AIDA 叙事结构（注意→兴趣→渴望→行动），确保信息传递清晰有序。每个技术概念均需配以 Mermaid 架构图或代码示例表格，复杂流程使用流程图分解步骤。

文档引用必须指向具体文件位置，采用 `[filename](relative/path#L<start>-L<end>)` 格式，杜绝无来源陈述。跨页面引用使用 `[Page Name](page_slug)` 语法保持一致性。