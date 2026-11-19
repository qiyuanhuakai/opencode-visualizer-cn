import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { appendFile, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createBridgeRuntime } from '../../bridgeRuntime.js';
import { createVisBridgeServer } from '../../visBridgeServer.js';
import { stopProcessTree } from '../../processTree.js';
import { createRemoteServices } from '../remoteServices.js';
import { createProfileStore } from './profileStore.js';
import { openRemoteRuntime } from './remoteRuntimeClient.js';

async function inspectThroughManager(endpoint, target) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const timer = setTimeout(() => finish(new Error('forwarded inspect timeout')), 10000);
    let attached = false;
    const finish = (error, value) => { clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(value); };
    socket.onerror = () => finish(new Error('forwarded inspect socket failed'));
    socket.onmessage = event => {
      const frame = JSON.parse(event.data);
      if (frame.kind === 'hello') {
        socket.send(JSON.stringify({ version: 1, kind: 'request', id: randomUUID(), target: frame.target, epoch: frame.epoch, generation: frame.generation, method: 'runtime.target.attach', params: { target } }));
      } else if (frame.kind === 'result') {
        if (!frame.ok) { finish(new Error(JSON.stringify(frame.typedError))); return; }
        if (attached) { finish(undefined, frame.result); return; }
        attached = true;
        const binding = frame.result.hello;
        socket.send(JSON.stringify({ version: 1, kind: 'request', id: randomUUID(), target, epoch: binding.epoch, generation: binding.generation, method: 'runtime.inspect', params: {} }));
      }
    };
  });
}

if (process.argv[2] === 'server') {
  const spec = JSON.parse(process.env.VIS_REMOTE_QA_SPEC);
  const runtime = createBridgeRuntime({ role: 'execution', environmentId: spec.environmentId, configPath: spec.configPath, stateRoot: path.join(spec.root, 'compute'),
    localWorkspaceRoots: [{ root: spec.root, permissions: ['read', 'write', 'command', 'pty', 'reverse'] }] });
  const server = createVisBridgeServer({ host: '127.0.0.1', bridgeToken: spec.bridgeToken, runtime, configPath: spec.configPath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(spec.root, 'ready.json'), JSON.stringify({ port: server.address().port }));
  const stop = () => server.close();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
} else {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-ssh-'));
  const configPath = path.join(root, 'bridge.json');
  await writeFile(configPath, JSON.stringify({ version: 1, nativeServices: { opencode: false, codex: false, 'kimi-web': false, dsh: false }, acpAgents: [] }));
  const environmentId = randomUUID(), bridgeToken = randomBytes(24).toString('hex');
  const passphrase = process.argv.includes('--passphrase') ? randomBytes(20).toString('hex') : '';
  const passwordMethod = process.argv.includes('--password') ? 'password' : process.argv.includes('--keyboard') ? 'keyboard-interactive' : undefined;
  const password = passwordMethod ? randomBytes(20).toString('hex') : '';
  const authenticationSecret = passphrase || password;
  const identity = path.join(root, 'id_ed25519'), sshConfig = path.join(root, 'ssh_config');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-f', identity]);
  await appendFile('/home/labuser/.ssh/authorized_keys', await readFile(identity + '.pub'));
  const targetConfig = `Host compute-qa\n HostName vislab-cn1\n User labuser\n IdentityFile ${identity}\n${passwordMethod ? ' Port 2222\n' : ''}`;
  if (process.argv.includes('--jump')) {
    const included = path.join(root, 'compute.conf'), knownJump = path.join(root, 'known_jump');
    await writeFile(knownJump, execFileSync('ssh-keyscan', ['-T', '5', 'vislab-login'], { stdio: ['ignore', 'pipe', 'ignore'] }));
    await writeFile(included, targetConfig + ' ProxyJump gateway-qa\n');
    await writeFile(sshConfig, `Include ${included}\nHost gateway-qa\n HostName vislab-login\n User labuser\n IdentityFile ${identity}\n UserKnownHostsFile ${knownJump}\n`);
  } else await writeFile(sshConfig, targetConfig);
  let passwordServer;
  if (passwordMethod) {
    execFileSync('chpasswd', [], { input: `labuser:${password}\n` });
    passwordServer = spawn('nsenter', ['--net=/var/run/netns/cn1', '--uts=/run/uts/cn1', '/usr/sbin/sshd', '-D', '-e',
      '-o', 'Port=2222', '-o', 'PasswordAuthentication=yes', '-o', 'KbdInteractiveAuthentication=yes', '-o', 'UsePAM=yes',
      '-o', `PidFile=${path.join(root, 'sshd.pid')}`], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    await pause(200);
  }
  const child = spawn('nsenter', ['--net=/var/run/netns/cn1', '--uts=/run/uts/cn1', process.execPath, fileURLToPath(import.meta.url), 'server'], {
    detached: true, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, VIS_REMOTE_QA_SPEC: JSON.stringify({ root, environmentId, bridgeToken, configPath }) },
  });
  let remote, managerServer, managerClient;
  const result = { root, observations: [], challenges: [] };
  try {
    let ready;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = JSON.parse(await readFile(path.join(root, 'ready.json'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await pause(100);
    }
    assert(ready);
    const store = createProfileStore({ profilePath: path.join(root, 'profiles.json') });
    const knownHosts = path.join(root, 'known_hosts');
    const remoteService = createRemoteServices({ profileStore: store, ssh: { configPath: sshConfig, knownHostsPath: knownHosts, remotePort: ready.port },
      resolveCredential: async () => ({ bridgeToken }) });
    const managerEnvironmentId = randomUUID();
    const managerRuntime = createBridgeRuntime({ role: 'manager', environmentId: managerEnvironmentId, configPath,
      stateRoot: path.join(root, 'manager'), remoteServices: remoteService });
    managerServer = createVisBridgeServer({ host: '127.0.0.1', runtime: managerRuntime, configPath, remoteServices: remoteService, profileStore: store });
    await new Promise(resolve => managerServer.listen(0, '127.0.0.1', resolve));
    managerClient = await openRemoteRuntime({ endpoint: `ws://127.0.0.1:${managerServer.address().port}/runtime`, environmentId: managerEnvironmentId });
    remote = {
      mutate: async (operation, args) => (await managerClient.request({ method: 'runtime.host.mutate', idempotencyKey: randomUUID(), params: { domain: 'remote', operation, args } })).value,
      read: (operation, args) => managerClient.request({ method: 'runtime.host.read', params: { domain: 'remote', operation, args } }),
      getTarget: target => remoteService.getTarget(target),
      close: () => remoteService.close(),
    };
    const profile = await remote.mutate('create', { name: 'live SSH', role: 'execution', enabled: true, credentialRef: passwordMethod ? `system:${passwordMethod}` : passphrase ? 'keyring:passphrase' : 'system',
      transport: { kind: 'ssh', endpoint: 'compute-qa' }, target: { kind: 'ssh', environmentId } });
    const connectWithAnswers = async () => {
    const connecting = remote.mutate('connect', { profileId: profile.profileId });
    let settled = false; connecting.then(() => { settled = true; }, () => { settled = true; });
    while (!settled) {
      for (const challenge of await remote.read('challenges', { profileId: profile.profileId })) {
        assert.equal(challenge.environmentId, environmentId);
        result.challenges.push({ kind: challenge.kind, profileId: challenge.profileId, environmentId: challenge.environmentId });
        await remote.mutate('respond', { profileId: profile.profileId, challengeId: challenge.challengeId,
          answer: ['passphrase', 'password', 'otp'].includes(challenge.kind) ? { secret: authenticationSecret } : { accept: true, persist: true } });
      }
      await pause(20);
    };
    await connecting;
    }
    await connectWithAnswers();
    assert.equal(remote.getTarget(environmentId).hello.target, environmentId);
    assert.equal(result.challenges[0].kind, 'host-key');
    const attached = await managerClient.request({ method: 'runtime.target.attach', params: { target: environmentId } });
    assert.equal(attached.grant.target, environmentId);
    const forwarded = await inspectThroughManager(`ws://127.0.0.1:${managerServer.address().port}/runtime`, environmentId);
    assert(forwarded.targets.some(target => target.target === environmentId));
    result.observations.push('manager Host RPC challenge response completed while connect was pending; authenticated target attach succeeded');
    result.observations.push('separate manager WebSocket attached execution target and forwarded real runtime.inspect over SSH');
    if (process.argv.includes('--jump')) result.observations.push('OpenSSH Include alias resolved through a trusted ProxyJump gateway');
    result.observations.push('real keyscan, contextual first trust, pinned OpenSSH forward and authenticated runtime hello');
    const before = await remote.getTarget(environmentId).request({ method: 'runtime.inspect', params: {} });
    await remote.mutate('disconnect', { profileId: profile.profileId });
    assert.equal(remote.getTarget(environmentId), undefined);
    await connectWithAnswers();
    const after = await remote.getTarget(environmentId).request({ method: 'runtime.inspect', params: {} });
    assert.equal(before.connectionProfileId, after.connectionProfileId);
    result.observations.push('reconnect retained stable runtime identity through a fresh owned forward');
    if (passphrase) {
      assert(result.challenges.some(challenge => challenge.kind === 'passphrase'));
      result.observations.push('encrypted private key authenticated using challenge answer via single-use askpass file');
    }
    if (passwordMethod) {
      assert(result.challenges.some(challenge => challenge.kind === (passwordMethod === 'password' ? 'password' : 'otp')));
      result.observations.push(`real OpenSSH ${passwordMethod} authentication delivered challenge secret through askpass`);
    }
    await remote.mutate('disconnect', { profileId: profile.profileId });
    await writeFile(knownHosts, `${passwordMethod ? '[vislab-cn1]:2222' : 'vislab-cn1'} ${(await readFile(identity + '.pub', 'utf8')).trim()}\n`);
    await assert.rejects(connectWithAnswers(), error => error.code === 'unauthorized');
    assert.equal(remote.getTarget(environmentId), undefined);
    result.observations.push('changed host key refused before any authenticated target was retained');
    if (authenticationSecret) {
      const managerRoot = path.join(root, 'manager');
      for (const entry of await readdir(managerRoot, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) assert.equal((await readFile(path.join(entry.parentPath, entry.name))).includes(Buffer.from(authenticationSecret)), false, entry.name);
      }
      result.observations.push('manager durable state and journals contain no plaintext challenge secret');
    }
    result.passed = true;
  } catch (error) { result.passed = false; result.error = { message: error.message, code: error.code, field: error.field }; process.exitCode = 1; }
  finally { managerClient?.close(); await remote?.close(); if (managerServer) await new Promise(resolve => managerServer.close(resolve)); await stopProcessTree(child); if (passwordServer) await stopProcessTree(passwordServer); console.log(JSON.stringify(result, null, 2)); }
}
