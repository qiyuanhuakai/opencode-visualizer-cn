import { spawn } from 'node:child_process';

const DESCENDANT_SWEEP = String.raw`
$ErrorActionPreference = 'Stop'
$rootPid = [uint32]$env:VIS_BRIDGE_TREE_ROOT_PID
$force = $env:VIS_BRIDGE_TREE_FORCE -eq '1'
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$frontier = @($rootPid)
$targets = [System.Collections.Generic.List[uint32]]::new()
while ($frontier.Count -gt 0) {
  $next = @($processes | Where-Object { $frontier -contains [uint32]$_.ParentProcessId })
  if ($next.Count -eq 0) { break }
  foreach ($process in $next) { $targets.Add([uint32]$process.ProcessId) }
  $frontier = @($next | ForEach-Object { [uint32]$_.ProcessId })
}
if ($targets.Count -eq 0) { exit 0 }
$targetIds = @($targets)
if ($force) {
  Stop-Process -Id $targetIds -Force -ErrorAction SilentlyContinue
} else {
  Stop-Process -Id $targetIds -ErrorAction SilentlyContinue
}
$deadline = [DateTime]::UtcNow.AddSeconds(3)
do {
  $alive = @(Get-Process -Id $targetIds -ErrorAction SilentlyContinue)
  if ($alive.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 50
} while ([DateTime]::UtcNow -lt $deadline)
exit 1
`;

function runCommand(spawnProcess, command, args, options) {
  return new Promise((resolve) => {
    const child = spawnProcess(command, args, options);
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

export async function stopWindowsProcessTree(pid, force, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const taskkillArgs = ['/PID', String(pid), '/T'];
  if (force) taskkillArgs.push('/F');
  const taskkillCode = await runCommand(spawnProcess, 'taskkill', taskkillArgs, {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (taskkillCode === 0) return;

  const sweepCode = await runCommand(
    spawnProcess,
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DESCENDANT_SWEEP],
    {
      env: {
        ...process.env,
        VIS_BRIDGE_TREE_ROOT_PID: String(pid),
        VIS_BRIDGE_TREE_FORCE: force ? '1' : '0',
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  if (sweepCode !== 0) throw new Error(`Windows process tree did not stop (pid ${pid}).`);
}
