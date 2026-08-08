function stopProcessLines(matchingCommand) {
  return [
    'matching_vis_bridge_pids() {',
    ...matchingCommand.map((line) => `  ${line}`),
    '}',
    'pids="$(matching_vis_bridge_pids)"',
    'if [ -n "$pids" ]; then',
    '  collect_process_tree() {',
    '    for child in $(/usr/bin/pgrep -P "$1" 2>/dev/null || true); do collect_process_tree "$child"; done',
    '    printf "%s\\n" "$1"',
    '  }',
    '  tree_pids=""',
    '  for pid in $pids; do tree_pids="$tree_pids $(collect_process_tree "$pid")"; done',
    '  for pid in $tree_pids; do /bin/kill -TERM "$pid" 2>/dev/null || true; done',
    '  # Startup readiness may still be unwinding; allow its signal cleanup to finish.',
    '  attempt=0',
    '  tree_alive() { for pid in $tree_pids; do /bin/kill -0 "$pid" 2>/dev/null && return 0; done; return 1; }',
    '  while [ "$attempt" -lt 350 ] && tree_alive; do',
    '    /bin/sleep 0.1',
    '    attempt=$((attempt + 1))',
    '  done',
    '  for pid in $tree_pids; do /bin/kill -KILL "$pid" 2>/dev/null || true; done',
    'fi',
  ];
}

export function createLinuxMaintainerScript() {
  return [
    '#!/bin/sh',
    'set -e',
    ...stopProcessLines([
      'for executable in /proc/[0-9]*/exe; do',
      '  [ -e "$executable" ] || continue',
      '  [ "$(/usr/bin/readlink "$executable" 2>/dev/null || true)" = "/usr/bin/vis_bridge" ] || continue',
      '  pid="${executable#/proc/}"',
      '  printf "%s\\n" "${pid%/exe}"',
      'done',
    ]),
    'exit 0',
    '',
  ].join('\n');
}

export function createMacPreinstallScript() {
  return [
    '#!/bin/sh',
    ...stopProcessLines([
      '/usr/bin/pgrep -x vis_bridge 2>/dev/null | while IFS= read -r pid; do',
      '  executable="$(/usr/sbin/lsof -a -p "$pid" -d txt -Fn 2>/dev/null | /usr/bin/sed -n "s/^n//p" | /usr/bin/head -n 1)"',
      '  [ "$executable" = "/usr/local/bin/vis_bridge" ] && printf "%s\\n" "$pid"',
      'done',
    ]),
    'exit 0',
    '',
  ].join('\n');
}

export function windowsStopDaemonLines(label) {
  return [
    `  IfFileExists "$INSTDIR\\vis_bridge.exe" stop_existing_${label} continue_${label}`,
    `stop_existing_${label}:`,
    '  nsExec::ExecToStack \'"$INSTDIR\\vis_bridge.exe" stop\'',
    '  Pop $0',
    '  Pop $1',
    '  nsExec::ExecToLog \'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Process vis_bridge -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $\\"$INSTDIR\\vis_bridge.exe$\\" } | ForEach-Object { & $$env:SystemRoot\\System32\\taskkill.exe /PID $$_.Id /T /F | Out-Null }"\'',
    `continue_${label}:`,
  ];
}
