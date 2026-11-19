import { spawn, spawnSync } from 'node:child_process';
import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { parseSqueueOutput, parseScontrolShowJob } from './slurmJobs.js';

export function slurmAvailable() {
  return ['sbatch', 'squeue', 'scontrol', 'scancel', 'srun'].every(command =>
    spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 2000 }).status === 0);
}

export function runScheduler(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '', bytes = 0, settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve({ stdout });
    };
    const timer = setTimeout(() => finish(new ProtocolError('timeout', 'slurm.scheduler')), 15000);
    child.on('error', () => finish(new ProtocolError('source_unavailable', 'slurm.scheduler')));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) finish(new ProtocolError('source_unavailable', 'slurm.output'));
      else stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) finish(new ProtocolError('source_unavailable', 'slurm.output'));
    });
    child.stdin.on('error', () => finish(new ProtocolError('source_unavailable', 'slurm.input')));
    child.on('exit', code => finish(code === 0 ? undefined : new ProtocolError('source_unavailable', 'slurm.scheduler')));
    child.stdin.end(input);
  });
}

export function createSlurmScheduler() {
  async function findSteps(jobId, name) {
    requireValue(/^\d+$/u.test(String(jobId)) && /^[0-9a-f-]{36}$/u.test(name), 'slurm.step_owner');
    const { stdout } = await runScheduler('scontrol', ['show', 'step', '--oneliner']);
    return stdout.split(/\r?\n/u).filter(line => new RegExp(`\\bName=${name}(?:\\s|$)`, 'u').test(line)).map(line => {
      const step = /\bStepId=(\d+\.\d+)/u.exec(line)?.[1];
      requireValue(step?.startsWith(`${jobId}.`), 'slurm.step_owner', 'conflict');
      return step;
    });
  }
  async function describe(jobId) {
    requireValue(/^\d+$/u.test(String(jobId)), 'slurm.jobId');
    const { stdout } = await runScheduler('scontrol', ['show', 'job', '--oneliner', String(jobId)]);
    const value = parseScontrolShowJob(stdout);
    const restarts = Number(/\bRestarts=(\d+)/u.exec(stdout)?.[1] ?? 0);
    return { ...value, restarts, state: value.jobState, nodes: value.nodeList };
  }
  return Object.freeze({
    submit: request => runScheduler('sbatch', [...request.argv], request.script),
    async query({ uuid, jobId }) {
      const { stdout } = await runScheduler('squeue', ['--noheader', '--format=%i|%j|%T|%k|%P|%N', `--name=${uuid}`]);
      const matches = parseSqueueOutput(stdout).filter(job => job.name === uuid);
      if (matches.length) return { matches: await Promise.all(matches.map(async job => ({ ...job, ...await describe(job.jobId) }))) };
      if (jobId) {
        const job = await describe(jobId);
        requireValue(job.name === uuid, 'slurm.job_owner', 'conflict');
        return { matches: [job] };
      }
      return { matches: [] };
    },
    cancel: ({ jobId }) => {
      requireValue(/^\d+$/u.test(String(jobId)), 'slurm.jobId');
      return runScheduler('scancel', [String(jobId)]);
    },
    describe,
    findSteps,
    async stopStep(jobId, name) {
      const owned = await findSteps(jobId, name);
      for (const step of owned) await runScheduler('scancel', [step]);
      return owned.length;
    },
    async nodeAddress(node) {
      requireValue(typeof node === 'string' && /^[A-Za-z0-9_.-]+$/u.test(node), 'slurm.node');
      const { stdout } = await runScheduler('scontrol', ['show', 'node', '--oneliner', node]);
      const address = /\bNodeAddr=(\S+)/u.exec(stdout)?.[1];
      requireValue(address, 'slurm.node_address', 'source_unavailable');
      return address;
    },
  });
}
