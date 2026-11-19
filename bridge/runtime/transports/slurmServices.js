import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, open as openFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import path from 'node:path';
import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { resolveProfileEnvironment } from '../../../shared/runtime/connectionProfile.js';
import { createBridgeConfigStore } from '../../bridgeConfig.js';
import { loadRuntimeRegistrations } from '../runtimeRegistrations.js';
import { createSlurmControlStore } from './slurmControlStore.js';
import { createSlurmJobController } from './slurmJobs.js';
import { createSlurmScheduler, slurmAvailable, runScheduler } from './slurmScheduler.js';
import { buildStepArgv } from './slurmStepTransport.js';
import { CONTROL_STORE_SCHEMA_VERSION } from './slurmControlStore.js';
import { bootstrapLayout, stageSlurmRuntime, WAIT_FOR_BOOTSTRAP } from './slurmBootstrapRuntime.js';
import { parseSlurmDeployment, assertSlurmRoots, slurmRuntimeBinding } from './slurmDeployment.js';
import { createSlurmTcpTransport } from './slurmTcpTransport.js';
import { createSlurmStepTransport } from './slurmStepTransport.js';
import { openRemoteRuntime } from './remoteRuntimeClient.js';

export function createSlurmServices(options = {}) {
  const available = Boolean(options.stateRoot) && !process.env.SLURM_JOB_ID && slurmAvailable();
  const environments = new Map(), live = new Set();
  const scheduler = createSlurmScheduler();
  async function context(profile) {
    requireValue(available, 'slurm.scheduler', 'source_unavailable');
    requireValue(profile.transport.kind === 'slurm', 'slurm.profile');
    const endpoint = profile.transport.endpoint;
    requireValue(endpoint === undefined || [hostname(), 'localhost', '127.0.0.1', ...(options.loginHosts ?? [])].includes(endpoint), 'slurm.login_host', 'unauthorized');
    const environmentId = resolveProfileEnvironment(profile);
    if (!environments.has(environmentId)) {
      const promise = (async () => {
        const root = path.join(options.stateRoot, 'slurm', environmentId);
        const durable = createSlurmControlStore({ root, environmentId, ownerInstanceId: randomUUID() });
        await durable.open('owner');
        let writes = Promise.resolve();
        const enqueue = (method, args) => {
          const result = writes.then(() => durable[method](...args));
          writes = result.then(() => undefined, () => undefined);
          return result;
        };
        const store = Object.freeze({ ...durable,
          writeIntent: (...args) => enqueue('writeIntent', args),
          updateIntent: (...args) => enqueue('updateIntent', args),
          async readIntent(...args) { await writes; return durable.readIntent(...args); },
          async listIntents() { await writes; return durable.listIntents(); },
          async close() { await writes; return durable.close(); },
        });
        try {
          const config = await createBridgeConfigStore({ configPath: options.configPath }).load();
          const keys = ['opencode', 'codex', 'kimi-web', 'dsh', ...(config.acpAgents.length ? config.acpAgents.map(agent => `acp:${agent.id}`) : ['acp:unconfigured'])];
          const registrations = await loadRuntimeRegistrations(root, keys);
          const identities = Object.fromEntries([...registrations.harnesses].map(([key, id]) => [Buffer.from(key).toString('base64url'), id]));
          identities['management-profile'] = registrations.connectionProfileId;
          return { root, store, config, identities, chain: Promise.resolve() };
        } catch (error) { await store.close(); throw error; }
      })();
      environments.set(environmentId, promise);
      promise.catch(() => environments.delete(environmentId));
    }
    return environments.get(environmentId);
  }
  async function serialize(profile, operation) {
    const ctx = await context(profile);
    const result = ctx.chain.then(() => operation(ctx));
    ctx.chain = result.then(() => undefined, () => undefined);
    return result;
  }
  async function find(ctx, profile, intentId) {
    if (intentId) {
      requireValue(/^[0-9a-f-]{36}$/iu.test(intentId), 'slurm.intent');
      const intent = await ctx.store.readIntent(intentId);
      requireValue(intent?.profileId === profile.profileId, 'slurm.intent', 'unauthorized');
      return intent;
    }
    const active = (await ctx.store.listIntents()).filter(intent => intent.profileId === profile.profileId && intent.terminal === null);
    requireValue(active.length === 1, 'slurm.active_intent', active.length ? 'conflict' : 'source_unavailable');
    return active[0];
  }
  function controller(ctx, profile, deployment) {
    return createSlurmJobController({
      store: ctx.store, scheduler, environmentId: resolveProfileEnvironment(profile),
      async prepareSubmission({ intentId }) {
        const credential = randomBytes(32).toString('base64url');
        const secrets = path.join(ctx.root, 'credentials');
        await mkdir(secrets, { recursive: true, mode: 0o700 });
        await writeFile(path.join(secrets, intentId), credential, { mode: 0o600, flag: 'wx' });
        const relayStepId = randomUUID(), serviceStepId = randomUUID();
        const layout = bootstrapLayout(deployment, intentId);
        const nodeProgram = layout.nodeProgram;
        const deployedWorker = layout.workerPath;
        const spec = { intentId, environmentId: resolveProfileEnvironment(profile), relayStepId, serviceStepId, deployment,
          config: ctx.config, registrations: ctx.identities, nodeProgram, workerPath: deployedWorker };
        await ctx.store.updateIntent(intentId, { profileId: profile.profileId, deployment, relayStepId, serviceStepId, ...layout });
        return { command: layout.installRoot ? '/bin/sh' : nodeProgram,
          args: layout.installRoot ? ['-c', WAIT_FOR_BOOTSTRAP, 'vis-runtime', layout.installRoot, nodeProgram, deployedWorker] : [deployedWorker, 'batch'],
          env: { NODE_OPTIONS: '', NODE_PATH: '', VIS_SLURM_RUNTIME_SPEC: JSON.stringify(spec), VIS_BRIDGE_RELAY_CREDENTIAL: credential } };
      },
    });
  }
  function scopedStore(ctx, intentId) {
    const check = id => requireValue(id === intentId, 'slurm.storage_scope', 'unauthorized');
    return {
      readIntent: id => { check(id); return ctx.store.readIntent(id); },
      updateIntent: (id, patch) => {
        check(id);
        requireValue(Object.keys(patch).every(key => ['bridge', 'transport', 'computeNode', 'restartCount'].includes(key)), 'slurm.storage_patch', 'unauthorized');
        return ctx.store.updateIntent(id, patch);
      },
    };
  }
  async function submit(profile, input) {
    const deployment = parseSlurmDeployment(input);
    return serialize(profile, async ctx => {
      assertSlurmRoots(ctx.root, deployment);
      const active = (await ctx.store.listIntents()).filter(intent => intent.profileId === profile.profileId && intent.terminal === null);
      requireValue(active.length === 0, 'slurm.active_intent', 'conflict');
      return controller(ctx, profile, deployment).submit({
        resources: deployment.allocation, computeWorkingRoot: deployment.computeWorkingRoot, sharedRoot: deployment.sharedRoot,
      });
    });
  }
  async function operate(profile, operation, intentId) {
    return serialize(profile, async ctx => {
      const intent = await find(ctx, profile, intentId);
      const jobs = controller(ctx, profile, intent.deployment);
      switch (operation) {
        case 'state': return intent;
        case 'reconcile': {
          let current = await jobs.reconcile(intent.intentId);
          if (current.installRoot && current.schedulerState === 'RUNNING' && current.bootstrapEpoch !== current.restartCount && (current.bootstrapRetryAfter ?? 0) <= Date.now()) {
            try {
              const receipt = await stageSlurmRuntime(current);
              current = await ctx.store.updateIntent(current.intentId, { bootstrapEpoch: current.restartCount, bootstrap: receipt, bootstrapError: null, bootstrapRetryAfter: null });
            } catch (error) {
              current = await ctx.store.updateIntent(current.intentId, { bootstrapError: { code: error.code ?? 'source_unavailable', field: error.field ?? 'slurm.bootstrap' }, bootstrapRetryAfter: Date.now() + 3000 });
            }
          }
          return current;
        }
        case 'detach': return jobs.detach(intent.intentId);
        case 'stop': {
          if (intent.ownership !== 'borrowed') return jobs.stop(intent.intentId);
          const stoppedSteps = await scheduler.stopStep(intent.jobId, intent.serviceStepId);
          const current = await scheduler.describe(intent.jobId);
          if (current.comment?.startsWith(`${intent.intentId}:vis:`)) await runScheduler('scontrol', ['update', `JobId=${intent.jobId}`, `Comment=${intent.originalComment ?? ''}`]);
          await ctx.store.updateIntent(intent.intentId, { terminal: 'COMPLETED', attached: false });
          return { intentId, cancelled: false, signalled: stoppedSteps > 0, stoppedSteps, reason: 'borrowed', terminal: 'COMPLETED', jobId: intent.jobId };
        }
        default: throw new ProtocolError('unsupported', 'slurm.operation');
      }
    });
  }
  async function borrow(profile, jobId, input) {
    const deployment = parseSlurmDeployment(input);
    return serialize(profile, async ctx => {
      assertSlurmRoots(ctx.root, deployment);
      requireValue(!(await ctx.store.listIntents()).some(intent => intent.profileId === profile.profileId && intent.terminal === null), 'slurm.active_intent', 'conflict');
      const job = await scheduler.describe(jobId);
      requireValue(job.state === 'RUNNING', 'slurm.borrow_state', 'source_unavailable');
      requireValue(/^[A-Za-z0-9_.-]+$/u.test(job.nodes), 'slurm.borrow_node');
      const intentId = randomUUID(), serviceStepId = randomUUID(), relayStepId = randomUUID();
      const layout = bootstrapLayout(deployment, intentId);
      const nodeProgram = layout.nodeProgram;
      const deployedWorker = layout.workerPath;
      const intent = { schemaVersion: CONTROL_STORE_SCHEMA_VERSION, kind: 'slurm.job', environmentId: resolveProfileEnvironment(profile),
        intentId, uuid: intentId, profileId: profile.profileId, ownership: 'borrowed', jobId: String(jobId), deployment,
        serviceStepId, relayStepId, nodeProgram, workerPath: deployedWorker, ...layout, originalComment: job.comment,
        state: 'RUNNING', queue: 'RUNNING', schedulerState: 'RUNNING', terminal: null, attached: false, bridge: 'UNKNOWN', transport: 'UNKNOWN',
        computeNode: job.nodes, restartCount: job.restarts, createdAt: Date.now() };
      await ctx.store.writeIntent(intent);
      const secrets = path.join(ctx.root, 'credentials');
      await mkdir(secrets, { recursive: true, mode: 0o700 });
      const credential = randomBytes(32).toString('base64url');
      await writeFile(path.join(secrets, intentId), credential, { mode: 0o600, flag: 'wx' });
      if (intent.installRoot) {
        const receipt = await stageSlurmRuntime(intent);
        await ctx.store.updateIntent(intentId, { bootstrapEpoch: intent.restartCount, bootstrap: receipt });
      }
      await launchBorrowed(ctx, intent, credential);
      return { intentId, jobId: String(jobId), ownership: 'borrowed', state: 'submitted' };
    });
  }
  async function launchBorrowed(ctx, intent, credential) {
      const existing = await scheduler.findSteps(intent.jobId, intent.serviceStepId);
      if (existing.length) return;
      requireValue(intent.serviceLaunchEpoch !== intent.restartCount || Date.now() - intent.serviceLaunchedAt > 15000, 'slurm.service_starting', 'source_unavailable');
      await ctx.store.updateIntent(intent.intentId, { serviceLaunchEpoch: intent.restartCount, serviceLaunchedAt: Date.now() });
      const spec = { ...intent, config: ctx.config, registrations: ctx.identities };
      const argv = buildStepArgv({ mode: 'service', bridgeNode: intent.computeNode, jobId: intent.jobId, stepId: intent.serviceStepId,
        compute: intent.deployment.resources, gres: intent.deployment.resources.gres, program: intent.nodeProgram, args: [intent.workerPath, 'service'] });
      const log = await openFile(path.join(ctx.root, `${intent.intentId}.log`), 'a', 0o600);
      try {
        const child = spawn('srun', ['--immediate=10', ...argv], { detached: true, stdio: ['ignore', log.fd, log.fd], shell: false,
          env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', SLURM_RESTART_COUNT: String(intent.restartCount), VIS_SLURM_RUNTIME_SPEC: JSON.stringify(spec), VIS_BRIDGE_RELAY_CREDENTIAL: credential } });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      } finally { await log.close(); }
  }
  async function open(profile) {
    const ctx = await context(profile);
    const initial = await find(ctx, profile);
    const intent = await controller(ctx, profile, initial.deployment).reconcile(initial.intentId);
    requireValue(intent.schedulerState === 'RUNNING' && !intent.terminal, 'slurm.queue', 'source_unavailable');
    if (intent.installRoot && intent.bootstrapEpoch !== intent.restartCount) {
      await serialize(profile, async current => {
        const latest = await find(current, profile, intent.intentId);
        if (latest.bootstrapEpoch === latest.restartCount) return;
        const receipt = await stageSlurmRuntime(latest);
        await current.store.updateIntent(latest.intentId, { bootstrapEpoch: latest.restartCount, bootstrap: receipt });
      });
    }
    const locator = new RegExp(`^${intent.intentId}:vis:(\\d+):(\\d+)$`, 'u').exec(intent.schedulerComment ?? '');
    if (intent.ownership === 'borrowed' && (!locator || Number(locator[2]) !== intent.restartCount)) {
      await serialize(profile, async current => {
        const latest = await find(current, profile, intent.intentId);
        await launchBorrowed(current, latest, await readFile(path.join(current.root, 'credentials', intent.intentId), 'utf8'));
      });
    }
    requireValue(locator && Number(locator[2]) === intent.restartCount, 'slurm.bridge', 'source_unavailable');
    const binding = slurmRuntimeBinding(intent, intent.computeNode, intent.restartCount);
    const credential = await readFile(path.join(ctx.root, 'credentials', intent.intentId), 'utf8');
    const store = scopedStore(ctx, intent.intentId);
    let transport, client, monitor;
    try {
      switch (intent.deployment.mode) {
        case 'tcp': transport = await createSlurmTcpTransport({ credential, store, loginHosts: [hostname(), ...(options.loginHosts ?? [])] }).open({
          direct: true, binding, computeNode: binding.computeNode, forward: { remoteHost: await scheduler.nodeAddress(binding.computeNode), remotePort: Number(locator[1]), localPort: Number(locator[1]) },
        }); break;
        case 'relay': {
          transport = await createSlurmStepTransport({ credential, store, binding, stdioEncoding: 'base64-lines', relaySocketPath: path.join(intent.deployment.computeStateRoot, intent.intentId, 'runtime.sock'),
            env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
            loginHosts: [hostname(), ...(options.loginHosts ?? [])],
          }).open({ binding, step: { mode: 'relay', bridgeNode: binding.computeNode, jobId: intent.jobId,
            stepId: randomUUID(), program: intent.nodeProgram, programArgs: [path.join(path.dirname(intent.workerPath), 'slurmStdioRelay.js')],
          } });
          break;
        }
        default: throw new ProtocolError('unsupported', 'slurm.mode');
      }
      client = await openRemoteRuntime({ channel: transport.channel, environmentId: binding.environmentId });
      let closed = false;
      const owned = { client, async close() {
        if (closed) return;
        closed = true; clearInterval(monitor); live.delete(owned); client.close(); await transport.close();
      } };
      live.add(owned);
      client.subscribe(event => { if (event.kind === 'closed') void owned.close().catch(error => options.onError?.(error)); });
      let checking = false;
      monitor = setInterval(() => {
        if (checking) return;
        checking = true;
        void scheduler.describe(intent.jobId).then(job => {
          if (job.state !== 'RUNNING' || job.nodes !== binding.computeNode || job.restarts !== binding.epoch) return owned.close();
        }, () => owned.close()).catch(error => options.onError?.(error)).finally(() => { checking = false; });
      }, 2000); monitor.unref();
      await ctx.store.updateIntent(intent.intentId, { attached: true, bridge: 'ready', transport: 'ready' });
      return { client, transport: owned };
    } catch (error) { clearInterval(monitor); client?.close(); await transport?.close(); throw error; }
  }
  return Object.freeze({ available, submit, borrow, operate, open,
    async list(profile) { const ctx = await context(profile); return (await ctx.store.listIntents()).filter(intent => intent.profileId === profile.profileId); },
    async close() {
      const results = await Promise.allSettled([...live].map(handle => handle.close()));
      results.push(...await Promise.allSettled([...environments.values()].map(async pending => { const ctx = await pending; await ctx.chain; await ctx.store.close(); })));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Slurm service shutdown failed');
    },
  });
}
