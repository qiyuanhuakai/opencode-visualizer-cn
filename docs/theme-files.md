# Vis theme files

Vis themes are single-mode JSON profiles. You can import a profile in **Settings → Theme profiles** or contribute one as a built-in preset. A theme does not switch automatically with the operating system's light/dark mode. Code previews choose a light or dark syntax palette from the output panel's text color.

For AI agents creating themes, use the repository's [Vis theme authoring skill](../.agents/skills/vis-theme-authoring/SKILL.md). It includes the field map, design rules, registration path, validation command, and UI review matrix. The [Quiet Copper example](../.agents/skills/vis-theme-authoring/assets/quiet-copper.theme.json) is a complete importable starting point.

## Make an importable theme

1. Export a template from Theme profiles or copy the example. Set a new `id` and a clear `label`. New files should contain `"version": 1` and `"$schema": "/schema/theme.schema.json"`. The complete [JSON schema](../app/public/schema/theme.schema.json) defines the accepted keys. Older files without `version` still import; unsupported versions are rejected.
2. Fill in all nine required region objects: `topPanel`, `sidePanel`, `inputPanel`, `outputPanel`, `topDropdown`, `modalPanel`, `loginScreen`, `pageBackground`, and `chatCard`. Their individual fields are optional, but omitted values inherit existing tokens. For a coherent new palette, provide its main backgrounds, text, borders, controls, active states, and muted text instead of relying on the default theme for most surfaces.
3. Coordinate `topPanel.bg` with `topDropdown.bg`. The expanded top session/project menu should read as part of the bar, without a contrasting rectangular patch. If you set `components.dropdown.bg`, make it part of the same color family; it overrides generic dropdown backgrounds.
4. Compose depth through subtle gradients, translucency, and related surface tones. Avoid one flat color on every large region. Check text and controls over the brightest and darkest positions of each gradient. Light themes can use warm or cool off-white layers to reduce glare.
5. Set `floating` shared colors and per-type colors where needed. A floating window's full view and its compact thread-history entry use the same type background. Give light windows readable dark text; do not force a dark popup simply to solve contrast. `syntaxText` is optional and replaces multi-color syntax highlighting with one color in floating code views. Leave it unset when token colors should remain visible. Use an opaque hex, `rgb()` or `hsl()` color for `regions.outputPanel.text` so Vis can choose the matching code palette. Keep `floating.shell.backgroundColor` solid and put layered effects in `backgroundImage` so the terminal can match its background.

## Validate and inspect

Run the repository validator before importing:

```bash
node .agents/skills/vis-theme-authoring/scripts/validate-theme.mjs path/to/my-theme.json
```

It uses the app's current parser, schema rules, and CSS checks. It reports the failing field, such as `regions.topPanel.bg`. It also rejects IDs reserved by built-in profiles. When checking a built-in JSON file already registered under its ID, use `--builtin` before the path. Schema validation proves that the file is importable; it does not prove that the design is readable.

Import the file in Settings, then inspect the full workspace and at least one narrow viewport. Open the top dropdown, Settings modal, regular dropdowns and forms, floating windows, compact history entries, and a code preview. Check normal, muted, selected, hover, and focus text against the actual rendered background. For a built-in profile, also run the theme tests, lint, and build as listed in the [authoring skill](../.agents/skills/vis-theme-authoring/SKILL.md).

## Manage imported profiles

Imported profiles are stored locally. Their cards offer **Rename**, **Export**, and **Remove**. Rename changes the display label while preserving the stable ID. On an ID collision between imported profiles, **Keep both** gives the new copy an available `-imported` ID; **Replace** saves the old definition as a separate `-backup` profile before updating the original ID. Cancel leaves the registry unchanged. Built-in IDs are reserved; change the file ID before importing a file with one of those IDs.

If an older imported profile shares an ID with a newly added built-in, Vis migrates it to an available `-imported` ID and keeps an active imported profile selected. Export a profile before moving it to a different browser or installation.
