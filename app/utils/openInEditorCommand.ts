export const OPEN_IN_EDITOR_SHELL_COMMAND =
  'editor_cmd=${VISUAL:-${EDITOR:-}}; if [ -z "$editor_cmd" ]; then printf "%s\\n" "VISUAL/EDITOR is not set."; exit 127; fi; file=$1; set -f; set -- $editor_cmd; exec "$@" "$file"';
