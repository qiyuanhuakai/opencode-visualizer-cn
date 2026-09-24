# Vis Design System

## 1. Atmosphere & Identity

Vis feels like a compact terminal command center: dense, local-first, and precise. The recognizable signature is a layered dark workspace where every surface reads as a terminal-adjacent control plane, using muted slate panels, blue interaction accents, and monospace typography throughout.

Every new page or view must follow the Vis visual language and adapt to the active Vis theme. Reuse existing components, spacing, typography, and `--theme-*` tokens for its surfaces, text, borders, controls, and interaction states; verify the result in both light and dark themes before delivery.

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

Compact Kimi surfaces use the executable `--type-caption`, `--type-sm`, `--type-body`, and `--type-heading` variables declared in `app/styles/tailwind.css`.

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

These tokens are defined on `:root` in `app/styles/tailwind.css`; compact Kimi panels also use `--radius-control` (8px) and `--radius-panel` (10px).

### Grid

- Layout is application chrome, not a marketing grid.
- Floating windows fit inside the canvas when created, then keep a reachable titlebar after drag or resize ends.
- On a fresh viewport at or below 600px, the side panel starts collapsed so the workspace remains usable; a saved user choice takes precedence.
- Terminal panels should default to approximately 80x24 cells and then resize around measured xterm cell dimensions.

## 5. Components

Do not use system-native dropdowns such as HTML `<select>` in Vis interfaces. Use the shared `Dropdown`/`DropdownItem` components or another Vis-themed selector so the closed control and expanded options follow the active theme.

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
- **Narrow header**: below 1024px, the brand and global controls share the first row; the session selector and session controls wrap below. All actions remain visible and independently clickable, with no overlap or clipped dropdowns.

### Codex Collaboration and Goal Controls
- Composer collaboration modes reuse the OpenCode agent dropdown: mode name, 10px muted description, 2px row gap, ellipsis with full-description tooltip, and the existing selected checkmark/keyboard behavior. Default uses the OpenCode `success` palette token; Plan uses `accent`; other server modes use `secondary`. The same resolved color identifies the per-message mode and user quote border on history cards. Mode IDs remain stable across sends and refreshes; unknown legacy attribution is not guessed from the current selection.
- Reuse the compact panel, border, text and accent tokens above; preserve existing floating-window chrome.
- Collaboration presets are native selectable buttons with a visible selected label and `aria-pressed`. Explain that selection applies to the next message; distinguish this from running multiple agents.
- Show disconnected, loading, empty and failed mode discovery separately. A failed refresh must never look like an empty successful result.
- Goal editing belongs to the active thread. Explain unavailable, loading and error states next to the editor; disable mutations while the current thread is unresolved or disconnected.
- Goal objectives support multiline text up to 4,000 characters. Token budget is optional; blank means no budget, otherwise require a positive safe integer.
- Save/clear feedback uses an announced status or alert. Show token/time usage alongside the goal. Delayed results must not report success on a different thread.
- All controls have translated visible labels, keyboard focus, wrapping helper text and no added motion. At narrow widths, forms remain readable without horizontal scrolling.
- In the Codex composer, a compact Fast status sits after reasoning effort and before the flexible goal bar. Fast uses the same 28px height, 8px radius and input theme tokens, with a translated on/off label and an accent only when enabled. Its tooltip explains the /fast toggle and next-message scope. The goal bar uses a 120px minimum width and 28px height, grows into available toolbar space, truncates the objective with an ellipsis, and exposes full text in its tooltip. Narrow toolbars may wrap while keeping send controls reachable.
- Clicking the bar opens a dedicated, reusable floating goal window sized to the canvas; reopening restores its focus. The bar reflects current-thread updates and never shows another thread's goal while loading.
- The goal bar uses the composer's transparent resting surface, 8px control radius and `--theme-input-*` text/hover/focus tokens. Goal windows use `--theme-floating-*` surfaces and text, with 12px form panels and 8px controls; no fixed black/slate fills. Status selection reuses `Dropdown`/`DropdownItem` and the shared dropdown theme, including keyboard navigation and active states.

### File Tree Toolbar
- **Structure**: branch selector yields horizontal space to the file search control before any toolbar overflow occurs.
- **Spacing**: file search keeps a 96px minimum inline size; long branch names truncate with an ellipsis.
- **States**: search-result directories start expanded and remain independently collapsible without changing the non-search tree state.

### Codex Slash Controls
- Commands reuse the composer dropdown and existing status monitor navigation. Account Token activity and Codex quota windows belong to the Token tab, with quota windows below account activity.
- Codex Token status uses the App Server thread usage notification: compact themed rows for cumulative input/output/cache and the latest request, and a context-window meter based on latest input. Account activity stays a separate section below. Empty, disconnected, and thread-switch states never reuse another thread's usage.
- The Fast status is a native toggle button with `aria-pressed`, a visible keyboard focus ring, translated click/command guidance, and disabled/busy state while saving. The confirmed tier remains visible on failure and errors use the existing status surface. Clicking it preserves composer text and attachments.
- Permission and side-chat windows reuse the goal window's floating theme, 12px panel padding, 8px control spacing and radii, wrapping helper text and visible keyboard focus. No new color or motion tokens.
- Permission choices use native buttons with `aria-pressed`, explaining their effective scope and showing loading, disconnected and rejected changes.
- Side chat retains the main conversation, with an independent live transcript, labelled multiline composer, pending/error states and a close action. Narrow windows wrap content without horizontal overflow.

### Kimi Thread Goals
- Reuse the goal editor's floating surfaces, form controls, spacing and focus styles. The existing session menu opens a window bound to that session and connection; its identifier remains visible while other sessions are selected.
- Display server-confirmed goal status, usage and terminal reason. Loading or failed reads disable changes; repeated writes are blocked. Resume explicitly explains that it continues work and can consume tokens.
- Goal controls add no animation. Errors wrap and use an alert; status updates are announced.

### Kimi Account Quota
- Account quota lives in the existing status monitor Token tab and reuses quota bars and theme tokens. Show the server-provided 5-hour and 7-day usage windows with their reset times; keep loading, failed reads and successful empty responses distinct.

## 6. Motion & Interaction

### Conversation Cards and Session Selection
- Streaming and later assistant replies within the same user root update the existing card in place. The first assistant reply fades in with opacity over 180ms using ease-in-out; reduced-motion preference sets the transition to 0ms. Session selection uses an inset accent without changing row or label geometry.

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

### Kimi Agent Management
- The Mode-adjacent icon opens a compact upward settings popover using dropdown surface, border, focus and option tokens.
- Default subagent model and thinking effort use themed dropdown choices from the server; the independent tower experiment uses a compact switch.
- The popover contains no child-conversation browser or subagent run viewer. Loading, failure and saving states stay distinct; edits disable during requests and errors are announced.

### Kimi Plugin Management
- Plugin management lives in the existing status monitor Plugins tab and reuses modal surface, text, border and accent tokens.
- Installed plugins expose enable/disable and confirmed removal; a labelled source field and collapsible marketplace expose installation. Use 12px panels, 8px gaps/radii, wrapping content and visible keyboard focus, with no added motion.
- Keep installed state visible when an action fails. Distinguish unavailable marketplace, pending requests, action errors and a successful write whose refresh failed; announce feedback and disable concurrent mutations.

### Kimi Compact Controls (follow-up)
- Installed providers use the same compact rows as OpenCode; model detail expands on demand. Catalog uses dense two-column rows and one column on narrow screens. Controls are 28px, metadata 12px, and gaps use the shared spacing tokens.
- `manual`, `yolo`, `auto`, `tower`, `plan`, and `swarm` are protocol names and remain lowercase in every locale. The independent tower/plan/swarm toggles share one upward-opening composer dropdown labeled Mode (模式 in Chinese), with visible selected states in its menu.
- The Kimi goal bar belongs beside composer modes, following the Codex 28px flexible goal bar. A 28px icon-only settings button sits immediately after Mode. `/copyall` copies the complete session as Markdown, while `/compact` performs compaction. Every `/btw` opens a new, initially blank side-conversation window with inherited context available to the model. The top session tree keeps navigation, pin, rename, archive and delete.
- Plugin and quota rows use the status monitor's existing list-row, progress and action-button theme tokens in both light and dark themes, matching compact typography rather than independent cards.

### Provider Discovery
- Provider connection catalogs share a labelled search control that matches display names and provider IDs, with whitespace ignored at query edges. Display names sort A–Z with provider ID as the fallback.
- Reuse compact search, modal surface, border, muted text and focus tokens. A two-column list becomes one column below 640px. The list owns bounded vertical scrolling; a narrow right rail remains outside that scroll area and lists only initials present in the filtered results (`#` for other initials).
- Letter buttons immediately scroll and focus the first matching row without animation. Search, empty results, navigation labels and jump actions are translated. Installed provider controls and model management keep independent state.
- Kimi catalog connection remains per provider. The custom provider entry sits above the catalog search, matching OpenCode's placement and using the existing modal surface and action tokens. Refresh actions are omitted from provider management.
