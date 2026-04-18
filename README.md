# OpenCode Visualizer CN

[English](#english) | [中文](#中文)

---

<a name="中文"></a>
## 简介

本项目是 [OpenCode](https://github.com/sst/opencode) 的一个第三方 Web UI，fork 自 [vis](https://github.com/xenodrive/vis)。由于上游仓库不接受 PR，我们将其作为独立项目持续维护，并进行了大量功能改进、性能优化和本地化支持。

> **核心改进方向**：界面汉化与 i18n 支持、字体与主题管理、会话批量操作与 Pin 功能、悬浮窗与 Dock 栏管理、性能优化。

---

## 致谢

本项目基于 [xenodrive/vis](https://github.com/xenodrive/vis) 构建，感谢原作者的出色工作。

原仓库特性包括：
- 以审阅为核心的悬浮窗口，保持工具输出和智能体推理的上下文
- 支持多项目和工作树的会话管理
- 内置语法高亮的代码和 diff 查看器
- 交互式智能体工作流的权限和问题提示
- 基于 xterm.js 的嵌入式终端

---

## 快速开始

```bash
git clone https://github.com/qiyuanhuakai/opencode-visualizer-cn
cd opencode-visualizer-cn
pnpm install
pnpm build
node server.js
```

建议使用 `nohup node server.js 2>&1 &` 将服务器放在后台持久运行。

然后打开 `http://localhost:23003`（本项目将默认端口从 3000 修改为 23003，以减少在 WSL 上与 Windows 服务的端口冲突）。

---

## 主要功能改进

与上游 [vis](https://github.com/xenodrive/vis) 相比，本项目增加了以下功能：

| 功能类别 | 改进内容 | 状态 |
|---|---|---|
| **国际化** | 完整 i18n 支持，添加简体中文 | ✅ 已上线 |
| **字体管理** | 支持设置 Shell 字体、界面等宽字体，系统字体自动发现 | 🅱️ Beta |
| **供应商与模型管理** | 查看/启用/禁用本地模型和供应商 | 🅱️ Beta |
| **状态监控** | 查看服务器、MCP、LSP、Plugin、Skills 状态，支持关闭 MCP 连接 | 🅱️ Beta |
| **主题设置** | 自定义各卡片不同组件颜色 | 🅱️ Beta |
| **编辑器集成** | 使用系统 `$EDITOR` 打开文本文件 | ✅ 已上线 |
| **代码行评论** | 鼠标拖拽选择范围，评价并附加到输入框 | ✅ 已上线 |
| **会话 Pin** | 侧栏增加 Sessions 栏，Pin 常用会话 | ✅ 已上线 |
| **批量管理** | 顶栏 Management 按钮，多选 Session 操作 | ✅ 已上线 |
| **取消归档** | 找回已归档的 Session | ✅ 已上线 |
| **悬浮窗管理** | 全面覆盖的关闭/最小化按钮，底部 Dock 栏存放最小化窗口 | ✅ 已上线 |
| **快捷命令** | 支持 `@` 显式召唤代理 | ✅ 已上线 |
| **性能优化** | 超大 Session 懒加载、超多 Session 后台 Hydration、冷启动加速 | ✅ 已上线 |

> 📋 **详细变更日志**请参阅 [CHANGELOG.md](./CHANGELOG.md)

---

## 功能展示


### 1. 主界面与简体中文支持

<-- [主界面](docs/screenshots/main-interface.png) -->

### 2. 字体管理

<-- [字体管理](docs/screenshots/font-management.png) -->

### 3. 供应商与模型管理

<-- [模型管理](docs/screenshots/model-management.png) -->

### 4. 状态监控

<-- [状态监控](docs/screenshots/status-monitor.png) -->

### 5. 主题设置

<-- [主题设置](docs/screenshots/theme-settings.png) -->

### 6. 代码行评论

<-- [代码行评论](docs/screenshots/code-comment.png) -->

### 7. Session Pin

<-- [Session Pin](docs/screenshots/session-pin.png) -->

### 8. 批量管理
<-- [Session Pin](docs/screenshots/multi-manager.png) -->

### 9. 悬浮窗与 Dock 栏

<-- [Dock 栏](docs/screenshots/dock-bar.png) -->

---

## 开发

```sh
pnpm install
pnpm dev
```

## 声明

本项目是为 OpenCode 构建的第三方 Web UI，**并非**由 OpenCode 团队开发，且与他们**没有任何关联**。

## License

MIT

---

<a name="english"></a>
## Introduction

This project is a third-party Web UI for [OpenCode](https://github.com/sst/opencode), forked from [vis](https://github.com/xenodrive/vis). Since the upstream repository does not accept PRs, we maintain it as an independent project with significant feature improvements, performance optimizations, and localization support.

> **Core Improvement Areas**: UI internationalization (i18n), font & theme management, session batch operations & Pin functionality, floating window & Dock bar management, performance optimization.

## Acknowledgements

This project is built on top of [xenodrive/vis](https://github.com/xenodrive/vis). We thank the original authors for their excellent work.

Original features include:
- Review-first floating windows that keep tool output and agent reasoning in context
- Session management with multi-project and worktree support
- Syntax-highlighted code and diff viewers
- Permission and question prompts for interactive agent workflows
- Embedded terminal powered by xterm.js

## Quick Start

```bash
git clone https://github.com/qiyuanhuakai/opencode-visualizer-cn
cd opencode-visualizer-cn
pnpm install
pnpm build
node server.js
```

We recommend using `nohup node server.js 2>&1 &` to run the server persistently in the background.

Then open `http://localhost:3001` (default port changed from 3000 to 3001 to reduce conflicts with Windows services when using WSL).

## Key Improvements

Compared to upstream [vis](https://github.com/xenodrive/vis), this project adds:

| Category | Feature | Status |
|---|---|---|
| **Internationalization** | Full i18n support with Simplified Chinese | ✅ Available |
| **Font Management** | Shell font, UI monospace font, system font auto-discovery | 🅱️ Beta |
| **Provider & Model Mgmt** | View/enable/disable local models and providers | 🅱️ Beta |
| **Status Monitor** | View server, MCP, LSP, Plugin, Skills status; close MCP connections | 🅱️ Beta |
| **Theme Settings** | Customize colors for different card components | 🅱️ Beta |
| **Editor Integration** | Open text files with system `$EDITOR` | ✅ Available |
| **Code Line Comment** | Drag to select range and append comment to input | ✅ Available |
| **Session Pin** | Pinned Sessions panel in sidebar | ✅ Available |
| **Batch Management** | Multi-select session operations via Management button | ✅ Available |
| **Unarchive** | Restore previously archived sessions | ✅ Available |
| **Floating Window Mgmt** | Close/minimize buttons for all popups, bottom Dock bar | ✅ Available |
| **Quick Commands** | `@` shortcut to explicitly summon agents | ✅ Available |
| **Performance** | Lazy loading for large sessions, background hydration, faster cold start | ✅ Available |

> 📋 **Detailed changelog**: [CHANGELOG.md](./CHANGELOG.md)

## Development

```sh
pnpm install
pnpm dev
```

## Disclaimer

This is a third-party Web UI for OpenCode. It was **not** developed by the OpenCode team and has **no affiliation** with them.

## License

MIT
