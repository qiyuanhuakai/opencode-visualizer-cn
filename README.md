## 说明 Notice

本仓库源自[上游仓库](https://github.com/xenodrive/vis)的fork，由于上游仓库不接受pr，因此我已将它作为独立项目持续维护，并进行了一些功能改进和本地化支持，包括：

This repository is a fork of [the upstream repository](https://github.com/xenodrive/vis). Since the upstream does not accept pull requests, I have maintained it as an independent project and implemented several enhancements and localization features, including:

- 支持i18n，添加新语言：简体中文
- 添加字体管理功能（beta）
  - 允许设置shell字体
  - 允许设置界面等宽字体
  - 实现了系统字体自动发现功能（依赖于浏览器）
  - 实现了字体命中情况确认功能
- 添加供应商和模型管理功能（beta）
  - 允许查看现有和全部供应商
  - 允许查看、启用、禁用现有模型（仅限本地）
- 添加状态查看功能
  - 允许查看服务器、mcp、lsp、plugin、skills状态
  - 允许关闭mcp服务器连接（beta）
- 添加主题设置功能（beta）
  - 由于项目架构问题，主题系统只能以这种非常别扭的方案实现
  - 允许设置每一块卡片的不同组件的颜色（未完全适配）
- 添加session pin功能，在侧栏中增加了session栏，允许把常用session pin在侧边
- 添加批量管理功能，在顶栏增加了management按钮，实现多选session操作
- 添加取消归档功能，允许找回已经被归档的session
- 添加全面覆盖的关闭和最小化按钮，允许手动隐藏和最小化所有悬浮窗（也允许关闭最小化功能）
- 添加底部dock栏以存放最小化后的悬浮窗
- 修改默认端口以减少在wsl上使用时与windows服务的端口冲突
- 添加对"@"快捷命令的支持，用于显式召唤代理
- 一些性能改进
  - 对超级庞大的session应用了lazy loading，降低卡顿
  - 对超多session实现了background hydration，加快了冷启动的启动速度
- 清理了一些冗余代码

- Added i18n support with Simplified Chinese
- Add font management feature (beta)
  - Allow setting shell font
  - Allow setting monospace font for interface
  - Implemented system font auto-discovery feature (browser-dependent)
  - Implemented font hit confirmation feature
- Add provider and model management features (beta)
  - Allow viewing existing and all providers
  - Allow viewing, enabling, or disabling existing models (local only)
- Add status monitoring feature
  - Allow viewing server, MCP, LSP, plugin, and skills statuses
  - Allow closing MCP server connections (beta)
- Add theme settings feature (beta)
  - Due to project architecture issues, the theme system can only be implemented using this awkward approach
  - Allow setting colors for different components of each card (not fully adapted yet)
- Introduced session pinning functionality by adding a sessions panel in the sidebar to allow pinning frequently used sessions
- Implemented batch management via a new "Management" button in the top bar for multi-select operations on sessions 
- Added an unarchive feature to restore previously archived sessions
- Included comprehensive minimize and close buttons for all floating windows, enabling manual hiding and minimizing of all popups (with the option to disable auto-minimize behavior)
- Added a bottom dock bar to store minimized floating windows
- Adjusted the default port to reduce conflicts with Windows services when running in WSL
- Added support for "@" shortcut commands to explicitly summon agents
- Various performance improvements:
  - Implemented lazy loading for extremely large session lists to reduce lag
  - Enabled background hydration for sessions with very high counts, significantly speeding up cold starts
- Removed redundant code

由于本仓库没有在npm和其他地方发布，因此唯一的使用方法是：

Since this repository is not published on npm or other platforms, the only way to use it is as follows:

```
git clone https://github.com/qiyuanhuakai/opencode-visualizer-cn
cd opencode-visualizer-cn
pnpm install
pnpm build
node server.js
```
建议使用

It is recommended to use
```
nohup node server.js 2>&1 &
```
将服务器放在后台持久运行。

to run the server in the background persistently.

## 声明 Declaration

这个项目是为opencode构建的第三方webui，因此在名称中包含了opencode。其**并非**由OpenCode团队开发，且与他们**没有**任何关联：由于我更改了仓库名，特此声明 \
This project is a third-party web UI built for opencode, and therefore includes "opencode" in its name. It was **not** developed by the OpenCode team and has **no** affiliation with them: I am making this statement because I have changed the repository name.

以下为源仓库README文件：

# Vis

An alternative web UI for [OpenCode](https://github.com/sst/opencode), designed for daily use. It connects to a running OpenCode instance and provides a browser-based, window-style interface for managing sessions, viewing tool output, and interacting with AI agents in real time.

![Demo](docs/demo.gif)

## Features

- **Review-first floating windows** that keep tool output and agent reasoning in context
- Session management with **multi-project and worktree** support
- Syntax-highlighted **code and diff viewers** built for fast, confident review
- Permission and question prompts for interactive agent workflows
- Embedded terminal powered by xterm.js

## How to Use

### Cloud

**No installation required** — just open the hosted version in your browser:

**<https://xenodrive.github.io/vis/>**

All you need is a running OpenCode server with CORS enabled. Start it with:

```bash
opencode serve --cors https://xenodrive.github.io
```

Or add this to your `.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "server": {
    "cors": ["https://xenodrive.github.io"]
  }
}
```

and then:

```bash
opencode serve
```

### Local

The hosted version connects to your local OpenCode server, which some browsers may block due to security restrictions.
If this happens, you can serve the UI locally instead:

Start the UI server:

```bash
npx @xenodrive/vis
```

Start the OpenCode API server:

```bash
opencode serve
```

Then open `http://localhost:3000` in your browser.

---

## Development

```sh
pnpm install
pnpm dev
```

## License

MIT
