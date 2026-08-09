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

### File Tree Toolbar
- **Structure**: branch selector yields horizontal space to the file search control before any toolbar overflow occurs.
- **Spacing**: file search keeps a 128px minimum inline size; long branch names truncate with an ellipsis.
- **States**: search-result directories start expanded and remain independently collapsible without changing the non-search tree state.

## 6. Motion & Interaction

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
