// One-off: executes the task-46 Slurm driver leg DIRECTLY (outside the QA runner) with the exact
// registered argv, and writes its report, its captured log and its own receipt file under
// .omo/evidence/vis-v090/task-46/direct-slurm/<lane>/.
//
// The Slurm and SSH drivers provision the same isolated lab name. The Slurm
// leg runs first so the Task 46 worker can verify its independent receipt
// before it starts the SSH lab.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const head = git('rev-parse', 'HEAD');
const tree = git('rev-parse', 'HEAD^{tree}');
if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('Slurm direct lane requires a clean tracked checkout');
const DRIVER = 'scripts/qa/runtime-v090-live-slurm.mjs';
const lane = process.argv[2];
if (!['happy', 'failure'].includes(lane)) throw new Error('usage: node <this> happy|failure');

const directory = path.join(root, '.omo/evidence/vis-v090/task-46/direct-slurm', lane);
mkdirSync(directory, { recursive: true });
const out = path.join(directory, 'slurm.json');
const log = path.join(directory, 'slurm.log');
const receiptPath = path.join(directory, 'slurm.receipt.json');
const argv = [process.execPath, DRIVER, '--lab', 'isolated', '--modes', 'tcp,relay', '--case', lane, '--out', out];
const driverSha256 = sha256(readFileSync(path.join(root, DRIVER)));
const startedAt = new Date().toISOString();
const started = Date.now();
let exitCode = 0;
let signal = null;
let stream = '';
try {
  stream = execFileSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  exitCode = typeof error.status === 'number' ? error.status : 1;
  signal = error.signal ?? null;
  stream = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}
const finishedAt = new Date().toISOString();
writeFileSync(log, stream, 'utf8');
if (git('rev-parse', 'HEAD') !== head || git('status', '--porcelain', '--untracked-files=no') || sha256(readFileSync(path.join(root, DRIVER))) !== driverSha256) {
  throw new Error('Slurm candidate changed during execution');
}
const receipt = {
  schemaVersion: 1,
  task: 46,
  lane,
  surface: 'live-slurm',
  execution: 'direct (outside the QA runner)',
  reason: 'The isolated Slurm and SSH drivers provision the lab serially with independent receipts.',
  invocation: argv,
  invocationCwd: root,
  exitCode,
  signal,
  interrupted: false,
  startedAt,
  finishedAt,
  durationMs: Date.now() - started,
  log: path.relative(root, log),
  logBytes: stream.length,
  report: path.relative(root, out),
  reportExists: existsSync(out),
  driver: DRIVER,
  driverSha256,
  reportSha256: existsSync(out) ? sha256(readFileSync(out)) : null,
  logSha256: sha256(readFileSync(log)),
  head,
  tree,
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(`SLURM_${lane.toUpperCase()} exit=${exitCode} durationMs=${receipt.durationMs} report=${receipt.reportExists} driverSha256=${receipt.driverSha256.slice(0, 12)}`);
process.exitCode = exitCode;
