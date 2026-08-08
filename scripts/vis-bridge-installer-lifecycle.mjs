export function createLinuxMaintainerScript() {
  return [
    '#!/bin/sh',
    'set -e',
    'if [ -x /usr/bin/vis_bridge ]; then',
    '  if ! /usr/bin/vis_bridge stop; then',
    "    pkill -TERM -f '^/usr/bin/vis_bridge([[:space:]]|$)' || true",
    '  fi',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

export function createMacPreinstallScript() {
  return [
    '#!/bin/sh',
    'if [ -x /usr/local/bin/vis_bridge ]; then',
    '  if ! /usr/local/bin/vis_bridge stop; then',
    "    pkill -TERM -f '^/usr/local/bin/vis_bridge([[:space:]]|$)' || true",
    '  fi',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

export function windowsStopDaemonLines() {
  return [
    '  IfFileExists "$INSTDIR\\vis_bridge.exe" 0 +6',
    '  nsExec::ExecToStack \'"$INSTDIR\\vis_bridge.exe" stop\'',
    '  Pop $0',
    '  ${If} $0 != 0',
    '    nsExec::ExecToLog \'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Process vis_bridge -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $\\"$INSTDIR\\vis_bridge.exe$\\" } | Stop-Process -Force"\'',
    '  ${EndIf}',
  ];
}
