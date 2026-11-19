import { EventEmitter } from 'node:events';
import { ProtocolError } from '../../../shared/runtime/capabilities.js';

const CHUNK_BYTES = 48 * 1024;
const LINE_BYTES = 64 * 1024;

export function encodeSlurmStdio(data, write) {
  const bytes = Buffer.from(data);
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) write(bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') + '\n');
}

export function decodeSlurmStdio(receive) {
  let pending = '';
  return chunk => {
    if (chunk.some(byte => byte > 127)) throw new ProtocolError('invalid_request', 'slurm.stdio');
    pending += chunk.toString('ascii');
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (line.length > LINE_BYTES || line.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(line)) throw new ProtocolError('invalid_request', 'slurm.stdio');
      if (line) receive(Buffer.from(line, 'base64'));
    }
    if (pending.length > LINE_BYTES) throw new ProtocolError('invalid_request', 'slurm.stdio');
  };
}

export function slurmEnvelopeStream(child) {
  const events = new EventEmitter();
  const decode = decodeSlurmStdio(bytes => events.emit('data', bytes));
  child.stdout.on('data', chunk => {
    try { decode(chunk); } catch (error) { events.emit('error', error); }
  });
  child.stdout.on('end', () => events.emit('end'));
  child.on('error', error => events.emit('error', error));
  child.on('exit', () => events.emit('end'));
  return {
    get writableLength() { return child.stdin.writableLength; },
    on: (event, handler) => events.on(event, handler),
    off: (event, handler) => events.off(event, handler),
    write: bytes => encodeSlurmStdio(bytes, line => child.stdin.write(line)),
    end: () => child.stdin.end(),
    destroy: () => child.kill(),
  };
}
