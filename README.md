# 分叉说明

本仓库fork自[上游仓库](https://github.com/xenodrive/vis)，由于上游仓库不接受pr，因此我在本分叉进行了一些功能改进和本地化支持，包括：

- 支持i18n，添加新语言：简体中文
- 添加session pin功能，在侧栏中增加了session栏，允许把常用session pin在侧边
- 添加批量管理功能，在顶栏增加了management按钮，实现多选session操作（注：多选pin操作目前有问题，点一次只能pin一个）
- 添加取消归档功能，允许找回已经被归档的session
- 添加全面覆盖的关闭和最小化按钮，允许手动隐藏和最小化所有悬浮窗（也允许关闭最小化功能）
- 添加底部dock栏以存放最小化后的悬浮窗
- 修改默认端口以减少在wsl上使用时与windows服务的端口冲突
- 一些性能改进，特别是对超级庞大的session加载的性能改进

由于本仓库没有在npm和其他地方发布，因此唯一的使用方法是：
```
git clone https://github.com/qiyuanhuakai/vis_cn
cd vis_cn
pnpm install
pnpm build
node server.js
```
建议使用
```
nohup node server.js 2>&1 &
```
将服务器放在后台持久运行。

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
