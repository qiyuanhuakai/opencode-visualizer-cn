---
name: vis-theme-authoring
description: Create or revise Vis JSON themes, including imported profiles and built-in presets, with correct schema keys, layered surfaces, coordinated top bar menus, floating and history colors, and real UI validation. Use for Vis theme authoring; not for unrelated UI styling.
---

# Vis theme authoring

Produce a theme that is valid in the current Vis app and readable across its real surfaces. A theme is a single-mode profile; do not add automatic operating-system light/dark switching.

## Start from the current contract

1. Work from the Vis repository root (the directory containing `app/utils/themeRegistry.ts`). Read `app/public/schema/theme.schema.json`, `app/utils/themeFileValidation.ts`, and `DESIGN.md`. The schema defines allowed JSON keys; runtime validation also checks CSS values. Consult [the field and surface guide](references/theme-contract.md) when choosing colors or changing a built-in theme.
2. Export a template from **Settings → Theme profiles**, copy the structure of an existing `app/utils/*.theme_1.json`, or start from the validated [Quiet Copper example](assets/quiet-copper.theme.json). Do not copy a palette without redesigning the light, middle, and accent layers. Use a fresh ID for an external file; built-in IDs are reserved.
3. Decide whether the deliverable is **an importable JSON file** or **a built-in preset**. For an importable theme, deliver the JSON and demonstrate that Settings can import it. For a built-in, add the JSON under `app/utils/`, wire it into `regionTheme.ts` and `themeRegistry.ts`, and provide names, badges, and descriptions in all five locale files plus `app/i18n/types.ts`. Do not copy the source schema into JavaScript from `app/public`; `app/schema/theme.schema.json` is the importable source copy.

## Compose the palette

- Set all nine `regions` objects. The fields inside each may be omitted, but a mostly empty theme falls back to Vis defaults and can become an accidental mixed palette. Give the main regions coherent surface, text, border, control, active, and muted colors.
- Build visual depth with restrained gradients, translucent layers, or texture-like color variation across the page, panels, and cards. Avoid making every surface a single flat color. Keep contrast strong enough for normal and muted text, including hover, selected, disabled, and focused states.
- Make `regions.topDropdown.bg` match or closely resemble `regions.topPanel.bg`; check the expanded top session/project menu, not just the collapsed bar. `components.dropdown.bg` controls other dropdowns and can override generic dropdown colors, so coordinate it with the same palette.
- Give floating windows intentional shared colors and per-type colors as needed. A type's compact history entry must visually match its full window. On light themes, use light floating surfaces with dark readable text; do not use a dark popup as a workaround for weak text contrast. Shell and Forge terminal ink and ANSI colors must follow the shell surface too, including after a theme switch. Leave `syntaxText` unset when multi-color code highlighting is desired. If an explicit single syntax color is intended, set it knowingly at shared or type level.
- Use an opaque solid color for `regions.outputPanel.text` and `floating.shell.backgroundColor`; hex, `rgb()` and `hsl()` are supported. The output text color selects the light or dark syntax palette, while the shell background sets terminal contrast. Put layered effects in `backgroundImage`. Verify both in a real code preview and shell.

## Validate and deliver

1. Run `node .agents/skills/vis-theme-authoring/scripts/validate-theme.mjs path/to/theme.json`. For a built-in file already registered under its ID, pass `--builtin` before the file path. Fix every reported schema or CSS error; this checks import behavior but cannot judge visual quality.
2. Import or select the theme in the running app. Inspect the top bar with its dropdown open, side panel, input and output, modal, form controls, a full floating window, its compact history entry, and code highlighting. Check a narrow viewport and at least one text-heavy state. Capture screenshots for light and dark themes when changing shared theme code.
3. For a built-in change, run `npm test -- --testTimeout 20000 app/utils/themeRegistry.test.ts app/utils/themeTokens.test.ts app/composables/useRegionTheme.test.ts`, `npm run lint`, and `npm run build`. Run broader tests when shared mappings or behavior changed. Report which surfaces were actually inspected and any remaining limitation. Do not claim a theme is finished from JSON/schema validation alone.

See [the field and surface guide](references/theme-contract.md) for inheritance, registration, and review details. Keep that guide aligned with the application when theme keys change.
