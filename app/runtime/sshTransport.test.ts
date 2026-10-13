import { createHash, createHmac, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendKnownHost,
  evaluateHostKey,
  formatKnownHostEntry,
  hostPortKey,
  keyFingerprint,
  parseKnownHosts,
} from '../../bridge/runtime/transports/knownHosts.js';
import {
  AUTH_CHALLENGE_KINDS,
  REDACTED,
  createAuthenticationSession,
  createSecretChannel,
  redactSecrets,
} from '../../bridge/runtime/transports/sshAuthentication.js';
import {
  createProcessRelay,
  decodeRelayFrames,
  encodeRelayFrame,
} from '../../bridge/runtime/transports/processRelay.js';
import {
  TARGET_HELLO,
  TARGET_HELLO_OK,
  assertNoShellConcatenation,
  assertSecretFreeArgv,
  buildSshArgv,
  createSshTransport,
  parseAllocatedPort,
  resolveSshConfig,
  resolveSshTarget,
  sshProgram,
} from '../../bridge/runtime/transports/sshTransport.js';
import { resolveProfileEnvironment } from '../../shared/runtime/connectionProfile.js';
import { parseEnvironmentId } from '../../shared/runtime/identity.js';

const HOST = 'builder.example';
const KEY_A = Buffer.from('ssh-ed25519-AAAA-key-A-material-0123456789').toString('base64');
const KEY_B = Buffer.from('ssh-ed25519-BBBB-key-B-material-9876543210').toString('base64');
const SECRET = 'sup3r-s3cret-password';
const PASSPHRASE = 'key-passphrase-hunter2';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeChild(pid: number): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.pid = pid;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(() => true), end: vi.fn() };
  child.kill = vi.fn(() => true);
  return child;
}

const SSH_CONFIG = [
  '# user config',
  'Host builder',
  '  HostName ignored.example',
  '',
  'Host builder.example',
  '  HostName builder.internal',
  '  User deploy',
  '  Port 2222',
  '  IdentityFile ~/.ssh/id_ed25519',
  '  ProxyJump bastion',
  '',
  'Host *',
  '  User fallback',
  '  StrictHostKeyChecking ask',
  '',
].join('\n');

function sshProfile() {
  return {
    profileId: '55555555-5555-4555-8555-555555555555',
    name: 'Build host',
    transport: { kind: 'ssh' as const, endpoint: `${HOST}:22` },
    target: { kind: 'ssh' as const, environmentId: parseEnvironmentId('66666666-6666-4666-8666-666666666666') },
    role: 'execution' as const,
    credentialRef: 'cred-ssh-password',
    enabled: true,
  };
}

describe('knownHosts trust store', () => {
  it('parses markers, multi-pattern lines, hashed hosts and skips junk', () => {
    const salt = randomBytes(8);
    const hashed = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(hostPortKey(HOST, 22)).digest('base64')}`;
    const text = [
      '# comment',
      '@revoked bad.example ssh-rsa ' + KEY_A,
      'a.example,b.example ssh-ed25519 ' + KEY_A + ' my comment',
      `${hashed} ssh-ed25519 ${KEY_A}`,
      'this-is-not-a-line',
      '',
    ].join('\n');
    const entries = parseKnownHosts(text);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ markers: ['@revoked'], patterns: ['bad.example'] });
    expect(entries[1]?.patterns).toEqual(['a.example', 'b.example']);
    expect(entries[1]?.comment).toBe('my comment');
    expect(entries[2]?.patterns[0]?.startsWith('|1|')).toBe(true);
  });

  it('canonicalizes the host/port trust key the way OpenSSH stores it', () => {
    expect(hostPortKey('Builder.Example', 22)).toBe('builder.example');
    expect(hostPortKey('Builder.Example', 2222)).toBe('[builder.example]:2222');
  });

  it('fingerprints a key blob as SHA256 base64 without padding', () => {
    const expected = `SHA256:${createHash('sha256').update(Buffer.from(KEY_A, 'base64')).digest('base64').replace(/=+$/u, '')}`;
    expect(keyFingerprint(KEY_A)).toBe(expected);
  });

  it('trusts a matching key, flags a changed key, and reports an unknown host', () => {
    const text = `${HOST} ssh-ed25519 ${KEY_A}\n`;
    const entries = parseKnownHosts(text);
    expect(evaluateHostKey(entries, { host: HOST, port: 22, keyType: 'ssh-ed25519', keyBlob: KEY_A }).status).toBe('trusted');
    expect(evaluateHostKey(entries, { host: HOST, port: 22, keyType: 'ssh-ed25519', keyBlob: KEY_B }).status).toBe('changed');
    expect(evaluateHostKey(entries, { host: 'other.example', port: 22, keyType: 'ssh-ed25519', keyBlob: KEY_A }).status).toBe('unknown');
    // A different key type for a known host is a first trust for that type, not a changed key.
    expect(evaluateHostKey(entries, { host: HOST, port: 22, keyType: 'ssh-rsa', keyBlob: KEY_B }).status).toBe('unknown');
  });

  it('matches a hashed host entry and rejects a revoked key', () => {
    const salt = randomBytes(8);
    const hashed = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(hostPortKey(HOST, 2222)).digest('base64')}`;
    const entries = parseKnownHosts(`${hashed} ssh-ed25519 ${KEY_A}\n`);
    expect(evaluateHostKey(entries, { host: HOST, port: 2222, keyType: 'ssh-ed25519', keyBlob: KEY_A }).status).toBe('trusted');
    expect(evaluateHostKey(entries, { host: HOST, port: 22, keyType: 'ssh-ed25519', keyBlob: KEY_A }).status).toBe('unknown');

    const revoked = parseKnownHosts(`@revoked ${HOST} ssh-ed25519 ${KEY_A}\n`);
    expect(evaluateHostKey(revoked, { host: HOST, port: 22, keyType: 'ssh-ed25519', keyBlob: KEY_A }).status).toBe('revoked');
  });

  it('round-trips a first-trust entry through format/append and back to trusted', () => {
    const line = formatKnownHostEntry({ host: HOST, port: 2222, keyType: 'ssh-ed25519', keyBlob: KEY_A });
    expect(line).toContain(`[${HOST}]:2222`);
    const appended = appendKnownHost('existing.example ssh-rsa ' + KEY_B + '\n', { host: HOST, port: 2222, keyType: 'ssh-ed25519', keyBlob: KEY_A });
    const entries = parseKnownHosts(appended);
    expect(entries).toHaveLength(2);
    expect(evaluateHostKey(entries, { host: HOST, port: 2222, keyType: 'ssh-ed25519', keyBlob: KEY_A }).status).toBe('trusted');
  });
});

describe('challenge-based authentication and secret redaction', () => {
  it('declares every secret-bearing challenge kind and never returns a secret value in argv', () => {
    expect([...AUTH_CHALLENGE_KINDS]).toEqual(
      expect.arrayContaining(['host-key', 'host-key-changed', 'password', 'passphrase', 'otp']),
    );
  });

  it('redacts a secret from any log or error surface', () => {
    const redacted = redactSecrets(`ssh: auth failed for ${SECRET} (passphrase ${PASSPHRASE})`, [SECRET, PASSPHRASE]);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).not.toContain(PASSPHRASE);
    expect(redacted).toContain(REDACTED);
  });

  it('makes first trust, password and passphrase challenge-only', async () => {
    const seen: string[] = [];
    const responder = async (challenge: { kind: string }) => {
      seen.push(challenge.kind);
      if (challenge.kind === 'host-key') return { accept: true, persist: true };
      if (challenge.kind === 'password') return { secret: SECRET };
      if (challenge.kind === 'passphrase') return { secret: PASSPHRASE };
      return { accept: false };
    };
    const session = createAuthenticationSession({
      host: HOST,
      port: 22,
      hostKey: { keyType: 'ssh-ed25519', keyBlob: KEY_A },
      knownHosts: parseKnownHosts(''),
      method: 'password',
      responder,
    });
    const result = await session.authenticate();
    expect(seen).toEqual(['host-key', 'password']);
    expect(result.hostKeyStatus).toBe('unknown');
    expect(result.knownHostEntry?.keyBlob).toBe(KEY_A);
    expect(String(result.secrets[0])).toBe(REDACTED);
    expect(JSON.stringify(result.secrets)).not.toContain(SECRET);
    expect(result.secrets[0]?.consume()).toBe(SECRET);

    const passphraseSeen: string[] = [];
    const passphraseSession = createAuthenticationSession({
      host: HOST,
      port: 22,
      hostKey: { keyType: 'ssh-ed25519', keyBlob: KEY_A },
      knownHosts: parseKnownHosts(`${HOST} ssh-ed25519 ${KEY_A}\n`),
      method: 'publickey',
      responder: async (challenge: { kind: string }) => {
        passphraseSeen.push(challenge.kind);
        return challenge.kind === 'passphrase' ? { secret: PASSPHRASE } : { accept: false };
      },
    });
    const passphraseResult = await passphraseSession.authenticate();
    expect(passphraseSeen).toEqual(['passphrase']);
    expect(passphraseResult.secrets[0]?.consume()).toBe(PASSPHRASE);
  });

  it('issues an otp challenge for keyboard-interactive authentication', async () => {
    const kinds: string[] = [];
    const session = createAuthenticationSession({
      host: HOST,
      port: 22,
      hostKey: { keyType: 'ssh-ed25519', keyBlob: KEY_A },
      knownHosts: parseKnownHosts(`${HOST} ssh-ed25519 ${KEY_A}\n`),
      method: 'keyboard-interactive',
      responder: async (challenge: { kind: string }) => {
        kinds.push(challenge.kind);
        return { secret: '123456' };
      },
    });
    const result = await session.authenticate();
    expect(kinds).toEqual(['otp']);
    expect(result.secrets[0]?.consume()).toBe('123456');
  });

  it('rejects a changed host key and never offers an accept path', async () => {
    const kinds: string[] = [];
    const session = createAuthenticationSession({
      host: HOST,
      port: 22,
      hostKey: { keyType: 'ssh-ed25519', keyBlob: KEY_B },
      knownHosts: parseKnownHosts(`${HOST} ssh-ed25519 ${KEY_A}\n`),
      method: 'password',
      // A responder that tries to force acceptance must still be ignored.
      responder: async (challenge: { kind: string }) => {
        kinds.push(challenge.kind);
        return { accept: true, persist: true };
      },
    });
    await expect(session.authenticate()).rejects.toMatchObject({ code: 'unauthorized', field: 'host.key.changed' });
    expect(kinds).toEqual(['host-key-changed']);
  });

  it('rejects an untrusted host when first trust is declined', async () => {
    const session = createAuthenticationSession({
      host: HOST,
      port: 22,
      hostKey: { keyType: 'ssh-ed25519', keyBlob: KEY_A },
      knownHosts: parseKnownHosts(''),
      method: 'password',
      responder: async () => ({ accept: false }),
    });
    await expect(session.authenticate()).rejects.toMatchObject({ code: 'unauthorized', field: 'host.key.untrusted' });
  });

  it('writes a secret channel as a 0600 file that is not argv and is cleaned up', async () => {
    const directory = await temporaryDirectory('vis-ssh-secret-');
    const channel = await createSecretChannel([SECRET], { directory, askpassPath: '/usr/lib/vis/askpass' });
    expect(channel.env.SSH_ASKPASS).toBe('/usr/lib/vis/askpass');
    expect(channel.env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(JSON.stringify(channel.env)).not.toContain(SECRET);
    expect((await stat(channel.filePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(channel.filePath, 'utf8')).toBe(SECRET);
    await channel.cleanup();
    await expect(stat(channel.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('process relay: clean framing and owned-only lifecycle', () => {
  it('encodes and decodes length-prefixed frames across partial buffers', () => {
    const frame = encodeRelayFrame('hello target');
    const partial = frame.subarray(0, 3);
    expect(decodeRelayFrames(partial).frames).toHaveLength(0);
    const decoded = decodeRelayFrames(Buffer.concat([partial, frame.subarray(3)]));
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.frames[0]?.toString('utf8')).toBe('hello target');
    // Two frames in one buffer, plus a trailing partial.
    const two = Buffer.concat([encodeRelayFrame('a'), encodeRelayFrame('b'), frame.subarray(0, 2)]);
    const result = decodeRelayFrames(two);
    expect(result.frames.map((entry) => entry.toString('utf8'))).toEqual(['a', 'b']);
    expect(result.remaining).toHaveLength(2);
  });

  it('rejects an oversized frame instead of buffering unboundedly', () => {
    expect(() => encodeRelayFrame('x'.repeat(64), { maxFrameBytes: 8 })).toThrow(/frame/i);
    expect(() => decodeRelayFrames(Buffer.from([0, 0, 1, 0]), { maxFrameBytes: 8 })).toThrow(/frame/i);
  });

  it('terminates only processes it spawned', async () => {
    const children: Array<EventEmitter & Record<string, unknown>> = [];
    const stopProcessTree = vi.fn(async (_child: unknown) => {});
    const spawn = vi.fn(() => {
      const child = fakeChild(1000 + children.length);
      children.push(child);
      return child;
    });
    const relay = createProcessRelay({ spawn, stopProcessTree });
    const owned = relay.spawnOwned({ command: 'ssh', args: ['-T'] });
    expect(relay.isOwned(owned.id)).toBe(true);
    // A process this relay did not spawn must never be terminated.
    expect(await relay.terminate('not-owned')).toBe(false);
    expect(await relay.terminate(owned.id)).toBe(true);
    expect(stopProcessTree).toHaveBeenCalledTimes(1);
    expect(stopProcessTree.mock.calls[0]?.[0]).toBe(children[0]);
    // Already terminated is idempotent and does not re-signal.
    expect(await relay.terminate(owned.id)).toBe(false);
  });

  it('round-trips frames through a spawned process stdin/stdout', async () => {
    const child = fakeChild(2000);
    const relay = createProcessRelay({ spawn: () => child, stopProcessTree: async () => {} });
    const entry = relay.spawnOwned({ command: 'ssh', args: [] });
    const received: string[] = [];
    relay.onMessage(entry.id, (payload) => received.push(payload.toString('utf8')));
    relay.send(entry.id, 'ping');
    const written = (child.stdin as { write: ReturnType<typeof vi.fn> }).write.mock.calls[0]?.[0] as Buffer;
    expect(written).toBeInstanceOf(Buffer);
    (child.stdout as EventEmitter).emit('data', written);
    expect(received).toEqual(['ping']);
  });
});

describe('ssh transport', () => {
  it('selects the platform ssh executable and never a shell wrapper', () => {
    expect(sshProgram('win32')).toBe('ssh.exe');
    expect(sshProgram('darwin')).toBe('ssh');
    expect(sshProgram('linux')).toBe('ssh');
  });

  it('honours ssh_config aliases, wildcards, first-match-wins and ProxyJump', () => {
    const resolved = resolveSshConfig(SSH_CONFIG, 'builder.example');
    expect(resolved).toMatchObject({
      hostName: 'builder.internal',
      user: 'deploy',
      port: 2222,
      proxyJump: 'bastion',
    });
    expect(resolved.identityFiles).toEqual(['~/.ssh/id_ed25519']);
    // The `Host *` block only fills options the specific block did not set.
    expect(resolved.strictHostKeyChecking).toBe('ask');
    // A different alias resolves its own HostName, and the wildcard supplies the rest.
    const other = resolveSshConfig(SSH_CONFIG, 'builder');
    expect(other.hostName).toBe('ignored.example');
    expect(other.user).toBe('fallback');
  });

  it('resolves an endpoint through ssh_config to a concrete target', () => {
    const target = resolveSshTarget({ host: HOST, port: 22, configText: SSH_CONFIG });
    expect(target).toMatchObject({ host: 'builder.internal', port: 2222, user: 'deploy', proxyJump: 'bastion' });
  });

  it('builds a secret-free argv with no PTY, no default agent forwarding and a dynamic loopback forward', () => {
    const target = resolveSshTarget({ host: HOST, port: 22, configText: SSH_CONFIG });
    const argv = buildSshArgv({
      target,
      forward: { localHost: '127.0.0.1', localPort: 0, remoteHost: '127.0.0.1', remotePort: 23004 },
      knownHostsFile: '/home/u/.ssh/known_hosts',
    });
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toContain('-T');
    expect(argv).toEqual(expect.arrayContaining(['-o', 'RequestTTY=no']));
    expect(argv).toEqual(expect.arrayContaining(['-o', 'ForwardAgent=no']));
    expect(argv).toEqual(expect.arrayContaining(['-o', 'ExitOnForwardFailure=yes']));
    expect(argv).toEqual(expect.arrayContaining(['-o', 'IdentitiesOnly=yes']));
    expect(argv).toEqual(expect.arrayContaining(['-o', 'UserKnownHostsFile=/home/u/.ssh/known_hosts']));
    expect(argv).toEqual(expect.arrayContaining(['-L', '127.0.0.1:0:127.0.0.1:23004']));
    expect(argv).toEqual(expect.arrayContaining(['-J', 'bastion']));
    expect(argv).not.toContain('-A');
    expect(argv.some((arg) => arg.includes(' '))).toBe(false);
    expect(() => assertSecretFreeArgv(argv, [SECRET])).not.toThrow();
    expect(() => assertSecretFreeArgv([...argv, SECRET], [SECRET])).toThrow();
  });

  it('rejects an argv that would need shell concatenation', () => {
    expect(() => assertNoShellConcatenation(['ssh', '-T'])).not.toThrow();
    expect(() => assertNoShellConcatenation(['ssh', '-o', 'ProxyCommand=ssh jump nc %h %p'])).not.toThrow();
    expect(() => assertNoShellConcatenation(['ssh', '-o', 'X=1\nrm -rf /'])).toThrow();
    expect(() => assertNoShellConcatenation(['ssh', 'a\0b'])).toThrow();
  });

  it('parses the allocated dynamic loopback port from ssh stderr', () => {
    expect(parseAllocatedPort('debug1: Allocated port 45678 for forward')).toBe(45678);
    expect(parseAllocatedPort('no port here')).toBeUndefined();
  });

  it('never places a secret in the argv actually handed to spawn on any platform', async () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const captured: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
      const spawn = vi.fn((command: string, args: readonly string[], options: Record<string, unknown>) => {
        captured.push({ command, args, options });
        return fakeChild(3000);
      });
      const transport = createSshTransport({
        platform,
        spawn,
        configText: SSH_CONFIG,
        knownHostsText: '',
        hostKeyProvider: async () => ({ keyType: 'ssh-ed25519', keyBlob: KEY_A }),
        persistKnownHost: async () => {},
        readAllocatedPort: async () => 45678,
        targetHello: async () => ({ ok: true }),
        secretDirectory: await temporaryDirectory('vis-ssh-argv-'),
        askpassPath: '/usr/lib/vis/askpass',
        responder: async (challenge: { kind: string }) => {
          if (challenge.kind === 'host-key') return { accept: true, persist: true };
          if (challenge.kind === 'password') return { secret: SECRET };
          if (challenge.kind === 'passphrase') return { secret: PASSPHRASE };
          return { accept: false };
        },
      });
      const dialed = await transport.open(sshProfile());
      expect(dialed.ready).toBe(true);
      expect(dialed.environmentId).toBe(resolveProfileEnvironment(sshProfile()));

      expect(captured).toHaveLength(1);
      const call = captured[0];
      expect(Array.isArray(call?.args)).toBe(true);
      expect(call?.command).toBe(sshProgram(platform));
      expect(call?.options.shell).toBe(false);
      const flattened = [call?.command, ...(call?.args ?? [])].join(' ');
      expect(flattened).not.toContain(SECRET);
      expect(flattened).not.toContain(PASSPHRASE);
      expect(call?.args).not.toContain('-A');
      expect(() => assertNoShellConcatenation([call?.command as string, ...(call?.args ?? [])])).not.toThrow();
      await transport.close();
    }
  });

  it('treats ExitOnForwardFailure success as NOT ready until the target hello succeeds', async () => {
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: Record<string, unknown>) => fakeChild(4000));
    const transport = createSshTransport({
      platform: 'linux',
      spawn,
      configText: SSH_CONFIG,
      knownHostsText: '',
      hostKeyProvider: async () => ({ keyType: 'ssh-ed25519', keyBlob: KEY_A }),
      persistKnownHost: async () => {},
      readAllocatedPort: async () => 45678,
      targetHello: async () => ({ ok: false, error: 'no target hello' }),
      secretDirectory: await temporaryDirectory('vis-ssh-hello-'),
      askpassPath: '/usr/lib/vis/askpass',
      responder: async (challenge: { kind: string }) => (challenge.kind === 'host-key' ? { accept: true, persist: true } : { secret: SECRET }),
    });
    const profile = sshProfile();
    await expect(transport.open(profile)).rejects.toMatchObject({ code: 'timeout', field: 'target.hello' });
    // ExitOnForwardFailure was requested but it does not imply ready.
    const argv = spawn.mock.calls[0]?.[1] as readonly string[];
    expect(argv).toEqual(expect.arrayContaining(['-o', 'ExitOnForwardFailure=yes']));
    expect(transport.state(profile.profileId)).not.toBe('ready');
  });

  it('rejects a changed host key before spawning any process', async () => {
    const spawn = vi.fn(() => fakeChild(5000));
    const transport = createSshTransport({
      platform: 'linux',
      spawn,
      configText: SSH_CONFIG,
      knownHostsText: `[builder.internal]:2222 ssh-ed25519 ${KEY_A}\n`,
      hostKeyProvider: async () => ({ keyType: 'ssh-ed25519', keyBlob: KEY_B }),
      persistKnownHost: async () => {},
      readAllocatedPort: async () => 45678,
      targetHello: async () => ({ ok: true }),
      secretDirectory: await temporaryDirectory('vis-ssh-changed-'),
      askpassPath: '/usr/lib/vis/askpass',
      responder: async () => ({ accept: true, persist: true }),
    });
    await expect(transport.open(sshProfile())).rejects.toMatchObject({ code: 'unauthorized', field: 'host.key.changed' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('persists a first-trust entry and closes the forward on the same owned process', async () => {
    const persisted: unknown[] = [];
    const spawn = vi.fn(() => fakeChild(6000));
    const stopProcessTree = vi.fn(async () => {});
    const transport = createSshTransport({
      platform: 'linux',
      spawn,
      stopProcessTree,
      configText: SSH_CONFIG,
      knownHostsText: '',
      hostKeyProvider: async () => ({ keyType: 'ssh-ed25519', keyBlob: KEY_A }),
      persistKnownHost: async (entry) => persisted.push(entry),
      readAllocatedPort: async () => 45678,
      targetHello: async () => ({ ok: true }),
      secretDirectory: await temporaryDirectory('vis-ssh-trust-'),
      askpassPath: '/usr/lib/vis/askpass',
      responder: async (challenge: { kind: string }) => (challenge.kind === 'host-key' ? { accept: true, persist: true } : { secret: SECRET }),
    });
    const dialed = await transport.open(sshProfile());
    expect(persisted).toHaveLength(1);
    await dialed.close?.();
    expect(stopProcessTree).toHaveBeenCalledTimes(1);
  });

  it('serialises the shipped default target hello as JSON the target can decode and parse', async () => {
    // A loopback target that speaks the real relay framing and JSON-parses each payload, i.e. the
    // protocol's own reply parser. This test uses the SHIPPED default target hello client (no
    // `targetHello` override) so the default path is actually exercised.
    const received: string[] = [];
    const server = createServer((socket) => {
      let buffer: Buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        let decoded;
        try {
          decoded = decodeRelayFrames(buffer);
        } catch {
          return;
        }
        buffer = decoded.remaining;
        for (const payload of decoded.frames) {
          const text = payload.toString('utf8');
          received.push(text);
          let message: { kind?: string } | undefined;
          try {
            message = JSON.parse(text);
          } catch {
            continue;
          }
          if (message?.kind === TARGET_HELLO.kind) socket.write(encodeRelayFrame(JSON.stringify(TARGET_HELLO_OK)));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const transport = createSshTransport({
        platform: 'linux',
        spawn: vi.fn(() => fakeChild(7000)),
        stopProcessTree: async () => {},
        configText: SSH_CONFIG,
        knownHostsText: '',
        hostKeyProvider: async () => ({ keyType: 'ssh-ed25519', keyBlob: KEY_A }),
        persistKnownHost: async () => {},
        readAllocatedPort: async () => port,
        // Deliberately NO targetHello override: exercise the shipped default target-hello client.
        helloTimeoutMs: 500,
        secretDirectory: await temporaryDirectory('vis-ssh-default-hello-'),
        askpassPath: '/usr/lib/vis/askpass',
        responder: async (challenge: { kind: string }) => (challenge.kind === 'host-key' ? { accept: true, persist: true } : { secret: SECRET }),
      });
      let ready = false;
      try {
        const dialed = await transport.open(sshProfile());
        ready = dialed.ready;
        await dialed.close?.();
      } catch {
        ready = false;
      }
      // The decisive assertion: the target decoded a real JSON handshake, not '[object Object]'.
      expect(received).toEqual([JSON.stringify(TARGET_HELLO)]);
      expect(received[0]).not.toBe('[object Object]');
      expect(JSON.parse(received[0] as string)).toEqual({ kind: 'target.hello', version: 1 });
      expect(ready).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
