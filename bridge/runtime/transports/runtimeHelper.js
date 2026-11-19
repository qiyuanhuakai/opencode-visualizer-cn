import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveInstalledStoreRoot, resolveStoreWorker } from '../storage/runtimeStore.js';
import { requireValue } from '../../../shared/runtime/capabilities.js';

export function resolveRuntimeHelper(name) {
  requireValue(['sshAskpass.mjs', 'slurmComputeRuntime.js', 'slurmStdioRelay.js'].includes(name), 'runtime.helper');
  const sea = process.getBuiltinModule?.('node:sea')?.isSea?.() === true;
  if (!sea) return { script: fileURLToPath(new URL(name, import.meta.url)), node: process.execPath };
  const root = resolveInstalledStoreRoot();
  requireValue(root, 'runtime.helper_install', 'source_unavailable');
  const script = path.join(root, 'transports', name);
  requireValue(existsSync(script), 'runtime.helper_script', 'source_unavailable');
  return { script, node: resolveStoreWorker(root).execPath };
}
