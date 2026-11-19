import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { encodeSlurmStdio, decodeSlurmStdio } from './slurmStdioEnvelope.js';

test('Slurm stdio carries arbitrary binary across fragmented line delivery', () => {
  const source = randomBytes(170000), lines = [], received = [];
  encodeSlurmStdio(source, line => lines.push(line));
  const wire = Buffer.from(lines.join(''));
  const decode = decodeSlurmStdio(bytes => received.push(bytes));
  for (let offset = 0; offset < wire.length; offset += 997) decode(wire.subarray(offset, offset + 997));
  assert.deepEqual(Buffer.concat(received), source);
});

test('Slurm stdio rejects malformed, non-ASCII, and over-budget unframed data', () => {
  for (const input of [Buffer.from('!!!!\n'), Buffer.from([255]), Buffer.alloc(65537, 65)]) {
    const decode = decodeSlurmStdio(() => assert.fail('invalid payload delivered'));
    assert.throws(() => decode(input), error => error.code === 'invalid_request');
  }
});
