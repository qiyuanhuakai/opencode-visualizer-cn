export const STOP_GRACE_MS = 1_500;
export const STARTUP_GRACE_MS = 300;

export const BRIDGE_CLIENT_METHODS = new Set([
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'terminal/kill',
  'terminal/release',
]);

export function sameAcpLaunch(previous, next) {
  return (
    previous.command === next.command &&
    JSON.stringify(previous.args) === JSON.stringify(next.args) &&
    JSON.stringify(previous.env ?? {}) === JSON.stringify(next.env ?? {})
  );
}

export function createAcpProcessStatus(agent) {
  return {
    id: agent.id,
    name: agent.name,
    kind: 'acp',
    command: agent.command,
    args: [...agent.args],
    enabled: agent.enabled,
    state: agent.enabled ? 'stopped' : 'disabled',
    owned: false,
    connected: false,
    droppedFrames: 0,
  };
}

export function summarizeAcpProcessError(stderr) {
  const lines = String(stderr)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .map((line) => (line.length > 512 ? '[long stderr line omitted]' : line));
  return lines.join('\n').slice(-2_048);
}

export function formatAcpProcessError(agent, stderr) {
  const summary = summarizeAcpProcessError(stderr);
  if (agent.id === 'oh-my-pi' && /SyntaxError:/u.test(summary) && /Bun v\d/u.test(summary)) {
    return `Oh My Pi failed to parse under the installed Bun runtime. Update Bun to the version required by the installed Oh My Pi package, then restart the agent.\n${summary}`;
  }
  return summary;
}
