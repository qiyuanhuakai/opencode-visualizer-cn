import { connect } from 'node:net';
import { parseArgs } from 'node:util';
import { encodeSlurmStdio, decodeSlurmStdio } from './slurmStdioEnvelope.js';
import { requireValue } from '../../../shared/runtime/capabilities.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { socket: { type: 'string' }, 'stdio-forward': { type: 'boolean' }, environment: { type: 'string' },
    job: { type: 'string' }, 'bridge-instance': { type: 'string' }, 'compute-node': { type: 'string' }, epoch: { type: 'string' } },
});
requireValue(positionals.length === 1 && positionals[0] === 'relay' && values['stdio-forward'] && values.socket, 'slurm.forward');
const socket = connect(values.socket);
const decode = decodeSlurmStdio(bytes => { if (!socket.write(bytes)) process.stdin.pause(); });
socket.on('drain', () => process.stdin.resume());
socket.once('connect', () => {
  process.stdin.on('data', bytes => {
    try { decode(bytes); } catch { socket.destroy(); process.exitCode = 1; }
  });
  process.stdin.on('end', () => socket.end());
});
socket.on('data', bytes => encodeSlurmStdio(bytes, line => { if (!process.stdout.write(line)) socket.pause(); }));
process.stdout.on('drain', () => socket.resume());
socket.on('error', () => { process.exitCode = 1; });
socket.on('close', () => { process.stdin.destroy(); });
process.stdin.on('error', () => { socket.destroy(); process.exitCode = 1; });
