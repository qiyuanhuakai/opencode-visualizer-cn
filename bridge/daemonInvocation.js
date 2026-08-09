import path from 'node:path';

export function createDaemonInvocation(options) {
  const { entryPath, execPath, serverArgs } = options;
  if (!entryPath) throw new Error('Unable to resolve the vis_bridge source entry path.');
  const isSea = options.isSea ?? Boolean(process.getBuiltinModule?.('node:sea')?.isSea());
  if (isSea || path.resolve(entryPath) === path.resolve(execPath)) {
    return { command: execPath, args: ['__daemon', ...serverArgs] };
  }
  return { command: execPath, args: [entryPath, '__daemon', ...serverArgs] };
}
