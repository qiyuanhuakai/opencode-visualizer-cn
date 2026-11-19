// One-off: executes the task-46 Slurm driver leg DIRECTLY (outside the QA runner) with the exact
// registered argv, and writes its report, its captured log and its own receipt file under
// .omo/evidence/vis-v090/task-46/direct-slurm/<lane>/.
//
// Why: the QA runner's worker receipt budget is a hard 180000 ms and the Slurm driver measures
// 137300 ms on this host, so a single registered invocation cannot contain it next to the SSH
// driver (97500 ms happy / 115100 ms failure). This script is the auditable direct leg the
// task-46 case module reads back and verifies.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = '/home/qiyuaner/apps/vis_app/vis-wt/vis-v090-task-20';
const DRIVER = 'scripts/qa/runtime-v090-live-slurm.mjs';
const lane = process.argv[2];
if (!['happy', 'failure'].includes(lane)) throw new Error('usage: node <this> happy|failure');

const directory = path.join(root, '.omo/evidence/vis-v090/task-46/direct-slurm', lane);
mkdirSync(directory, { recursive: true });
const out = path.join(directory, 'slurm.json');
const log = path.join(directory, 'slurm.log');
const receiptPath = path.join(directory, 'slurm.receipt.json');
const argv = [process.execPath, DRIVER, '--lab', 'isolated', '--modes', 'tcp,relay', '--case', lane, '--out', out];
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
const driverBytes = readFileSync(path.join(root, DRIVER));
const receipt = {
  schemaVersion: 1,
  task: 46,
  lane,
  surface: 'live-slurm',
  execution: 'direct (outside the QA runner)',
  reason: `the runner worker receipt budget is a hard 180000 ms and this driver measures 137300 ms on this host, so a single registered invocation cannot contain it next to the SSH driver`,
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
  driverSha256: createHash('sha256').update(driverBytes).digest('hex'),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(`SLURM_${lane.toUpperCase()} exit=${exitCode} durationMs=${receipt.durationMs} report=${receipt.reportExists} driverSha256=${receipt.driverSha256.slice(0, 12)}`);
process.exitCode = exitCode;
