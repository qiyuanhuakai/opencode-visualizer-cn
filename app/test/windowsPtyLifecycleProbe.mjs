import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPtyService } from '../../bridge/runtime/ptyService.js';

const directory = await mkdtemp(path.join(tmpdir(), 'vis-windows-pty-'));
const mode = process.argv[2] || 'exited';
const service = createPtyService();
try {
  const channel = service.connect({ subscriberId: 'native-probe', assertCurrent() {}, authorize(key) { if (key !== 'owned') throw new Error('Wrong workspace'); }, directory: async () => directory });
  const terminal = await channel.create({ workspaceKey: 'owned', command: process.env.COMSPEC || 'cmd.exe', args: ['/d', mode === 'live' ? '/k' : '/c', 'echo VIS_WINDOWS_PTY_LIFECYCLE'] });
  if (!(terminal.pid > 0)) throw new Error('PTY returned a placeholder PID');
  channel.subscribe(terminal.ptyId);
  let output = '', exited = false;
  for (let attempt = 0; attempt < 400; attempt++) {
    const page = channel.read(terminal.ptyId);
    for (const chunk of page.chunks) { output += chunk.data.toString(); channel.acknowledge(terminal.ptyId, chunk); }
    exited = page.exited;
    if (output.includes('VIS_WINDOWS_PTY_LIFECYCLE') && (mode === 'live' || exited)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!output.includes('VIS_WINDOWS_PTY_LIFECYCLE') || (mode !== 'live' && !exited)) throw new Error('PTY output/exit missing');
  if (mode === 'live') await service.close();
  else await channel.remove(terminal.ptyId);
  const receipt = { phase: 'removed', mode, terminalPid: terminal.pid, exitedBeforeCleanup: exited };
  console.log(JSON.stringify(receipt));
  process.send?.(receipt);
} finally {
  await service.close();
  await rm(directory, { recursive: true, force: true });
  if (process.connected) process.disconnect();
}
