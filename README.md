# Vis

Web-based visualizer for [OpenCode](https://github.com/sst/opencode). Connects to a running OpenCode instance and provides a browser UI for managing sessions, viewing tool output, and interacting with AI agents in real time.

## Setup

### Prerequisites

- Node.js 24+
- pnpm
- A running [OpenCode](https://github.com/sst/opencode) instance (default: `http://localhost:4096`)

### Install & Run

```sh
pnpm install
pnpm dev
```

Open `http://localhost:5173/vis` in your browser.

### Build for Production

```sh
pnpm build
```

Static files are written to `dist/`. Pushes to `main` auto-deploy to GitHub Pages.

## Usage

### Layout

The UI is split into three areas:

- **Top bar** — project directory, worktree, and session selectors
- **Main area** — message output (left) with floating tool windows, and a collapsible side panel (right)
- **Input bar** — message composer with agent/model selectors at the bottom

### Projects & Worktrees

Use the top bar dropdowns to switch between projects and git worktrees. Click **Open** to pick a different project directory. You can create and delete worktrees from the worktree dropdown.

### Sessions

Sessions are listed in the top bar dropdown. You can:

- **Create** a new session with the **+** button
- **Switch** between sessions from the dropdown
- **Search** sessions by typing in the search field
- **Delete** a session from the dropdown
- **Fork** a session at any message using the **FORK** button on a conversation round

### Sending Messages

Type in the input bar and press **Ctrl+Enter** to send. You can also:

- Attach images by pasting, drag-and-dropping, or clicking the attach button (PNG, JPEG, GIF, WebP)
- Use **/** to open the slash command picker, then **Tab** or **Enter** to select

### Agent & Model Selection

The toolbar below the input shows dropdowns for agent, model, and thinking mode:

| Control | Shortcut | Description |
|---------|----------|-------------|
| Agent | **Tab** / **Shift+Tab** | Cycle through available agents |
| Model | **Ctrl+M** | Open the model picker |
| Thinking | **Ctrl+.** / **Ctrl+,** | Cycle thinking-mode variants |

### Tool Windows

When the agent calls tools (file reads, edits, bash commands, grep, etc.), floating windows appear over the main area. Each window shows the tool output with syntax highlighting.

- **Drag** the title bar to move a window
- **Resize** from the edges
- Windows auto-expire shortly after the tool completes

### Side Panel

Toggle the side panel with the **<** / **>** button on the right edge. It has two tabs:

- **Todo** — shows the agent's todo list for the current session and any sub-agent sessions
- **Tree** — file tree with git status indicators. Click a file to view it; click the diff icon to see the session diff for that file

### Permissions & Questions

When the agent needs permission (e.g. to run a command or write a file), a permission window appears. Click **Allow** or **Deny** to respond.

When the agent asks a question with choices, a question window appears. Select your answer(s) and submit, or reject the question.

### Diffs

Click the diff indicator on a conversation round to view file changes made by that message. Diffs open in the side panel's tree view or in a floating file viewer window with before/after highlighting.

### Terminal

Shell sessions appear as floating terminal windows powered by xterm.js.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl+Enter** | Send message |
| **Tab** | Cycle agent forward |
| **Shift+Tab** | Cycle agent backward |
| **Ctrl+M** | Open model picker |
| **Ctrl+.** | Next thinking variant |
| **Ctrl+,** | Previous thinking variant |
| **/** (in empty input) | Open command picker |
| **Esc** | Close project picker dialog |

## Tech Stack

- [Vue 3](https://vuejs.org/) — UI framework
- [Vite](https://vite.dev/) — build tool
- [Shiki](https://shiki.style/) — syntax highlighting
- [xterm.js](https://xtermjs.org/) — terminal emulator
- TypeScript, pnpm

## License

MIT
