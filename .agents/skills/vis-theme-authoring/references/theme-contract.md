# Vis theme contract and surface map

Read this guide while authoring or revising a theme. The live schema at `app/public/schema/theme.schema.json` and the implementation remain authoritative.

## File shape

An external file is one JSON object, not an array. Use `"$schema": "/schema/theme.schema.json"` and `"version": 1` in new files. Legacy files without `version` import; any other version is rejected. `id`, `label`, and `regions` are required. `id` starts with an ASCII letter or digit and then uses ASCII letters, digits, `_`, or `-`. `label`, `badge`, `description`, and up to four CSS-color `swatches` describe the profile. Unknown keys are rejected at every schema object level. The app stores imported profiles locally; renaming changes the label, not the ID.

`regions` must contain `topPanel`, `sidePanel`, `inputPanel`, `outputPanel`, `topDropdown`, `modalPanel`, `loginScreen`, `pageBackground`, and `chatCard`. Each region may set `bg`, `text`, `border`, `accent`, `controlBg`, `activeBg`, `activeText`, and `textMuted`. A missing field inherits semantic defaults or another mapped region; that is useful for sparse variants but can yield inconsistent contrast when a whole region is left empty. For a distinct theme, populate the important fields in every region.

`components` is optional. Supported groups are `dropdown`, `chip`, `iconAction`, `dock`, `formControl`, `tab`, `badge`, `card`, `toggle`, `listRow`, `emptyState`, `actionButton`, and `search`. Read the schema before using a group's exact keys. For generic dropdown tokens, `components.dropdown` takes priority over `regions.topDropdown`, then `regions.modalPanel`; top panel menu surfaces also read the `topDropdown` region directly. A coherent top bar therefore needs both region colors and any component override checked together.

`floating` is optional and has shared surface, border, fill, text, opacity, image, and `syntaxText` keys. It also has `default`, `shell`, `reasoning`, `subagent`, `tool`, `file`, `diff`, `media`, `dialog`, `history`, and `debug` groups. A type group can set `accent`, `backgroundColor`, `text`, `textMuted`, `textSoft`, `textSecondary`, `syntaxText`, `opacity`, `titlebarOpacity`, and `backgroundImage`. For type colors, a type value wins over `floating.default`, then shared floating values. The same per-type background is used by the corresponding compact history entry; inspect both representations after changing it.

## Practical palette decisions

- Start with page, top bar, side panel, output, and modal layers. Vary hue, luminance, texture, or gradient direction between large surfaces. Keep controls and active states visible without turning each region into an unrelated block.
- Use `topPanel.bg` and `topDropdown.bg` as a matched pair. A small deliberate brightness change can work, but a large hue or luminance jump looks like an inset box. Generic `components.dropdown.bg` should also belong to this family.
- Evaluate normal and muted text on the actual composed background. A transparent text layer over a gradient can change contrast by position. Test text and icon controls on both ends of the gradient, at rest and on hover/selection. Check modal buttons and input placeholders too.
- For light themes, avoid nearly pure white across the whole workspace. Use gentle off-white or colored neutrals with enough separation between paper, controls, and page. Keep floating windows light and readable, and ensure their compact history entries have the same tonal role.
- Shell, Forge, and shell tool output windows use `floating.shell` colors; the shell tool's compact history entry uses the same surface and text colors. Use an opaque solid hex, `rgb()` or `hsl()` shell background and place gradients in `backgroundImage`. Xterm chooses matching ink and ANSI colors, while shell tool output uses the active syntax palette. Both update when the theme changes. Inspect the actual shell prompt and a shell tool result on both light and dark profiles: application output can contain its own color codes.
- `floating.syntaxText` and per-type `syntaxText` force a single color over syntax tokens in floating code views. Omit them when Shiki token colors should remain visible. The app currently chooses `github-light` when `regions.outputPanel.text` is a dark hex color, and `github-dark` otherwise. Inspect code blocks after selection; do not assume a theme's name determines this choice.
- Use valid CSS declarations for the field's intended property. `bg` and `backgroundColor` accept CSS backgrounds; `backgroundImage` accepts CSS background images; shadow fields require box-shadow values; opacity is 0 through 1. Invalid values fail runtime import even if they are JSON strings.

## Built-in registration

Built-in JSON files live in `app/utils/*.theme_1.json`. Wire a new file through `app/utils/regionTheme.ts` and add a `BUILTIN_THEME_ENTRIES` record in `app/utils/themeRegistry.ts`. Add localized preset name, description, and badge where appropriate in `app/locales/en.ts`, `eo.ts`, `ja.ts`, `zh-CN.ts`, and `zh-TW.ts`; update `app/i18n/types.ts` for new keys. Update tests that enumerate built-ins. Keep the schema source copy (`app/schema/theme.schema.json`) identical to the public copy only when changing the format itself; JSON theme files reference `/schema/theme.schema.json` as a URL, never import from `public` in JavaScript.

If replacing a built-in ID, consider existing imported themes and active selections. The registry migration moves colliding imports to an available `-imported` ID. Avoid changing IDs merely for a palette adjustment; stable IDs preserve selection and exports.

## Review matrix

Inspect in the app: Settings cards and modal; expanded top session/project menu against top bar; page, sidebar, composer, and output; dropdown, form, chip, tab, and icon actions; floating `shell`, `reasoning`, `subagent`, `tool`, `file`/`diff`, and `dialog` examples where available; compact history for matching types; code preview with syntax tokens; narrow and wide layouts. For code changes to shared mapping, compare at least one light and one dark profile. Record screenshot paths and any surface that could not be exercised rather than inferring it from token values.
