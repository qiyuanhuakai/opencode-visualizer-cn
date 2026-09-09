# Vis Design System

## 1. Atmosphere & Identity

Vis feels like a compact terminal command center: dense, local-first, and precise. The recognizable signature is a layered dark workspace where every surface reads as a terminal-adjacent control plane, using muted slate panels, blue interaction accents, and monospace typography throughout.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Surface/base | `--color-surface-900` | `#0f172a` | `#0f172a` | App background and deep panels |
| Surface/panel | `--color-surface-800` | `#1e293b` | `#1e293b` | Elevated panels and menu surfaces |
| Surface/control | `--color-region-control-bg` | `#0b1320` | `#0b1320` | Toolbar controls and compact buttons |
| Text/primary | `--color-text-100` | `#e2e8f0` | `#e2e8f0` | Primary UI labels and terminal foreground |
| Text/muted | `--color-text-300` | `#94a3b8` | `#94a3b8` | Secondary labels, hints, empty states |
| Border/default | `--color-region-border` | `#334155` | `#334155` | Floating windows, inputs, compact controls |
| Accent/primary | `--color-region-accent` | `#3b82f6` | `#3b82f6` | Active controls and focus surfaces |
| Accent/bright | `--color-accent-400` | `#60a5fa` | `#60a5fa` | Icons, links, and brand blue highlights |
| Status/success | `--color-success-400` | `#22c55e` | `#22c55e` | Success and connected indicators |
| Status/warning | `--color-warning-300` | `#fef08a` | `#fef08a` | Warnings and attention states |

### Rules

- Prefer existing `--theme-*` region tokens when a component is inside themed app chrome.
- Accent blue is interactive, not decorative.
- New semantic colors must be added here before use.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| H2 | 18px | 600 | 1.35 | 0 | Modal and panel section titles |
| H3 | 14px | 600 | 1.4 | 0 | Compact card and toolbar labels |
| Body | 13px | 400 | 1.5 | 0 | Main app text, chat content, terminal-adjacent UI |
| Body/sm | 12px | 400 | 1.45 | 0 | Sidebar, top panel, modal helper copy |
| Caption | 10px | 500 | 1.3 | 0.02em | Chips, badges, compressed metadata |

### Font Stack

- Primary: `var(--app-monospace-font-family)`.
- Terminal: `var(--term-font-family)` with the user-configurable terminal font stack.

### Rules

- The app intentionally uses monospace for both chrome and terminal-adjacent controls.
- Body text should stay at 12-13px unless the user changes font settings.

## 4. Spacing & Layout

### Base Unit

All spacing derives from a 4px base.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Tight icon and input gaps |
| `--space-2` | 8px | Compact button groups and row gaps |
| `--space-3` | 12px | Panel padding and toolbar gutters |
| `--space-4` | 16px | Modal rows and card spacing |
| `--space-6` | 24px | Larger floating panels |

### Grid

- Layout is application chrome, not a marketing grid.
- Floating windows fit inside the canvas when created, then keep a reachable titlebar after drag or resize ends.
- Terminal panels should default to approximately 80x24 cells and then resize around measured xterm cell dimensions.

## 5. Components

### Floating Window
- **Structure**: draggable titlebar, compact actions, scrollable or terminal body.
- **Variants**: code, diff, message, binary, term, plain.
- **Spacing**: titlebar height 22px, inner terminal padding 4px/8px from existing chrome constants.
- **States**: focused, minimized, closable, resizable, search-active, disabled action.
- **Activation**: an explicit user reopen of an existing window restores it from the dock, raises it above siblings, and focuses the body without re-resolving content or changing user-set geometry; automatic refreshes go through `open` and never steal focus.
- **Accessibility**: buttons use translated labels/titles; body remains keyboard focusable.
- **Motion**: scale transition on open/close only.

### Terminal Panel
- **Structure**: optional compact toolbar plus `.xterm-host` filling the remaining body; Forge may add a right-side metadata/preview rail for structured CLI reads.
- **Variants**: generic shell, one-shot PTY, Forge terminal.
- **Spacing**: toolbar uses 4px/8px gaps; terminal host flexes to fill.
- **States**: socket connecting, focused, command submitted, disabled send.
- **Accessibility**: prompt input has a label; shortcut buttons are native buttons with titles.
- **Motion**: no layout animation inside xterm; all resizing is direct and immediate.
- **Forge control layout**: Forge keeps command menus in the top toolbar, PTY/xterm in the main region, structured reads in a hideable/resizable right rail, and the agent/function prompt fixed at the bottom.
- **Forge auxiliary reads**: `forge list conversation --porcelain`, `forge conversation show <id> --md`, `forge conversation dump <id>`, and `forge info --porcelain` feed status chips, conversation lists, and preview panes only; realtime interaction remains the PTY/xterm surface.

### Compact Control Button
- **Structure**: icon-first button with optional label in menus/toolbars.
- **Variants**: default, active, disabled, danger.
- **Spacing**: 24px square for icon-only top panel controls; 8px horizontal gap when labeled.
- **States**: hover, active, focus-visible, disabled.
- **Accessibility**: every icon-only button has a translated title or aria-label.
- **Motion**: color/background transition only.

### Codex Collaboration and Goal Controls
- Reuse the compact panel, border, text and accent tokens above; preserve existing floating-window chrome.
- Collaboration presets are native selectable buttons with a visible selected label and `aria-pressed`. Explain that selection applies to the next message; distinguish this from running multiple agents.
- Show disconnected, loading, empty and failed mode discovery separately. A failed refresh must never look like an empty successful result.
- Goal editing belongs to the active thread. Explain unavailable, loading and error states next to the editor; disable mutations while the current thread is unresolved or disconnected.
- Goal objectives support multiline text up to 4,000 characters. Token budget is optional; blank means no budget, otherwise require a positive safe integer.
- Save/clear feedback uses an announced status or alert. Show token/time usage alongside the goal. Delayed results must not report success on a different thread.
- All controls have translated visible labels, keyboard focus, wrapping helper text and no added motion. At narrow widths, forms remain readable without horizontal scrolling.
- In the Codex composer, a flexible goal bar sits immediately after reasoning effort and before message actions. It uses a 120px minimum width and 28px height, grows into available toolbar space, truncates the objective with an ellipsis, and exposes full text in its tooltip. Narrow toolbars may wrap the bar while keeping send controls reachable.
- Clicking the bar opens a dedicated, reusable floating goal window sized to the canvas; reopening restores its focus. The bar reflects current-thread updates and never shows another thread's goal while loading.
- The goal bar uses the composer's transparent resting surface, 8px control radius and `--theme-input-*` text/hover/focus tokens. Goal windows use `--theme-floating-*` surfaces and text, with 12px form panels and 8px controls; no fixed black/slate fills. Status selection reuses `Dropdown`/`DropdownItem` and the shared dropdown theme, including keyboard navigation and active states.

### File Tree Toolbar
- **Structure**: branch selector yields horizontal space to the file search control before any toolbar overflow occurs.
- **Spacing**: file search keeps a 96px minimum inline size; long branch names truncate with an ellipsis.
- **States**: search-result directories start expanded and remain independently collapsible without changing the non-search tree state.

## 6. Motion & Interaction

### Desktop Settings
- Reuse SettingsModal navigation and ToggleSettingRow for persisted native preferences.
- Update cards use modal surface/border/text tokens, 12px padding, 8px gaps and 12px helper copy.
- Show checking, download progress, verified download, installer handoff, unsupported and error states explicitly; installer handoff is not installation success.
- Error text uses `--theme-status-error` (fallback `#f87171`). Long filenames and translated notices wrap; buttons retain keyboard focus outlines.
- Progress fill updates directly without layout animation. Native notification availability never disables the independent sound fallback.

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 120-150ms | ease-out | Button hover/press and toggle response |
| Standard | 180-240ms | ease-in-out | Floating window open/close transitions |

Rules: animate opacity/transform/color only; do not animate xterm layout or terminal dimensions.

## 7. Depth & Surface

### Strategy

Mixed tonal-shift and thin borders.

| Type | Value | Usage |
|------|-------|-------|
| Default border | `1px solid var(--theme-border-default, #334155)` | Floating windows and controls |
| Muted panel | `var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72))` | Secondary controls |
| Shell base | `var(--theme-floating-shell-background-color, #050505)` | Terminal body backing |

Shadows are reserved for existing modal/floating chrome; Forge integration must reuse the same floating-window shell surface rather than inventing a new material.
