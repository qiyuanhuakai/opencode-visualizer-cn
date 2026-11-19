import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { requireValue, ProtocolError } from '../../../shared/runtime/capabilities.js';
import { stopProcessTree } from '../../processTree.js';
import { buildStepArgv } from './slurmStepTransport.js';
import { resolveRuntimeHelper } from './runtimeHelper.js';
import { encodeSlurmStdio } from './slurmStdioEnvelope.js';

const INSTALL = 'set -eu; root=$1; parent=${root%/*}; mkdir -p -- "$parent"; temporary=$(mktemp -d "$parent/.vis-bootstrap.XXXXXX"); trap \'rm -rf -- "$temporary"\' EXIT INT TERM; base64 -d | tar -xf - -C "$temporary"; test -x "$temporary/$2"; test -f "$temporary/bridge/runtime/transports/slurmComputeRuntime.js"; chmod -R go-rwx "$temporary"; touch "$temporary/.ready"; if test -f "$root/.ready"; then exit 0; fi; test ! -e "$root"; mv -- "$temporary" "$root"';

export function bootstrapLayout(deployment, intentId) {
  const helper = resolveRuntimeHelper('slurmComputeRuntime.js');
  if (deployment.nodeProgram || deployment.workerPath) {
    requireValue(deployment.nodeProgram && deployment.workerPath, 'slurm.predeployed_runtime');
    return { nodeProgram: deployment.nodeProgram, workerPath: deployment.workerPath };
  }
  const installRoot = path.join(deployment.computeStateRoot, intentId, 'installation');
  return { installRoot, nodeProgram: path.join(installRoot, path.basename(helper.node)),
    workerPath: path.join(installRoot, 'bridge', 'runtime', 'transports', 'slurmComputeRuntime.js') };
}

export async function stageSlurmRuntime(intent) {
  requireValue(process.platform === 'linux', 'slurm.bootstrap_platform', 'unsupported');
  const helper = resolveRuntimeHelper('slurmComputeRuntime.js');
  const sourceRoot = path.resolve(path.dirname(helper.script), '../../..');
  const entries = ['bridge', 'shared', 'package.json', 'node_modules/node-pty'];
  requireValue(entries.every(entry => existsSync(path.join(sourceRoot, entry))), 'slurm.bootstrap_payload', 'source_unavailable');
  const argv = buildStepArgv({ mode: 'relay', bridgeNode: intent.computeNode, jobId: intent.jobId, stepId: randomUUID(),
    program: '/bin/sh', args: ['-c', INSTALL, 'vis-bootstrap', intent.installRoot, path.basename(helper.node)] });
  const target = spawn('srun', ['--immediate=10', ...argv], { detached: true, stdio: ['pipe', 'ignore', 'pipe'], shell: false });
  const archive = spawn('tar', ['--dereference', '-cf', '-', '-C', sourceRoot, ...entries, '-C', path.dirname(helper.node), path.basename(helper.node)], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  const closed = child => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new ProtocolError('source_unavailable', 'slurm.bootstrap_process')));
  });
  let bytes = 0;
  const encode = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > 512 * 1024 * 1024) { callback(new ProtocolError('source_unavailable', 'slurm.bootstrap_size')); return; }
    encodeSlurmStdio(chunk, line => this.push(line));
    callback();
  } });
  let diagnostic = '';
  for (const child of [target, archive]) child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-16384); });
  let timer;
  try {
    await Promise.race([
      Promise.all([closed(target), closed(archive), pipeline(archive.stdout, encode, target.stdin)]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new ProtocolError('timeout', 'slurm.bootstrap')), 120000); }),
    ]);
  } catch (error) {
    error.transportLog = diagnostic;
    throw error;
  } finally {
    clearTimeout(timer);
    await Promise.all([stopProcessTree(target), stopProcessTree(archive)]);
  }
  return { transferredBytes: bytes, installRoot: intent.installRoot };
}

export const WAIT_FOR_BOOTSTRAP = 'set -eu; remaining=300; while test ! -f "$1/.ready"; do test "$remaining" -gt 0 || exit 1; remaining=$((remaining - 1)); sleep 1; done; exec "$2" "$3" batch';
