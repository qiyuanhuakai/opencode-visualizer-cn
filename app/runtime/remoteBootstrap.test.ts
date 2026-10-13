// @vitest-environment node
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createDaemonInvocation } from '../../bridge/daemonInvocation.js';
import { assertLocalInstallerLocation, hostInstallPath } from '../../bridge/updatePlatform.js';
import { runRemoteBridgeUpdate } from '../../bridge/updateCli.js';
import {
  BOOTSTRAP_ACTIONS,
  BRIDGE_PROTOCOL_GENERATION,
  HOST_ARCHITECTURES,
  HOST_PLATFORMS,
  UPDATE_LOCATIONS,
  assertNoLocalInstallerForRemote,
  createBootstrapPlan,
  evaluateBridgeCompatibility,
  parseHostIdentity,
  probeHostIdentity,
  resolveUpdateLocation,
} from '../../bridge/runtime/transports/remoteBootstrap.js';
import {
  INSTALL_CHANNELS,
  REMOTE_CHANNELS,
  createRemoteInstallTransaction,
  planRemoteInstall,
  selectRemoteArtifact,
} from '../../bridge/runtime/transports/remoteInstall.js';

const LOCAL_ENV = '11111111-1111-4111-8111-111111111111';
const HOST_ENV = '22222222-2222-4222-8222-222222222222';
const ASSET_URL = 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/assets/1';

function sshProfile(environmentId = HOST_ENV) {
  return {
    profileId: '55555555-5555-4555-8555-555555555555',
    name: 'Build host',
    transport: { kind: 'ssh' as const, endpoint: '127.0.0.1:2222' },
    target: { kind: 'ssh' as const, environmentId },
    role: 'execution' as const,
    credentialRef: 'cred-ssh',
    enabled: true,
  };
}

function rawHost(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'linux',
    arch: 'x64',
    protocol: BRIDGE_PROTOCOL_GENERATION,
    environmentId: HOST_ENV,
    bridgeInstalled: true,
    bridgeVersion: '0.8.0',
    ...overrides,
  };
}

function hostIdentity(overrides: Record<string, unknown> = {}) {
  return parseHostIdentity({ transportKind: 'ssh', ...rawHost(), ...overrides });
}

function release(version = '0.8.0', arch = 'x64', digest = 'a') {
  return {
    version,
    assets: [{
      name: `VisBridge-${version}-${arch}-Linux.deb`,
      digest: `sha256:${digest.repeat(64)}`,
      size: 42,
      url: ASSET_URL,
    }],
  };
}

function installPlan(hostOverrides: Record<string, unknown> = {}, channel = 'transport') {
  return planRemoteInstall({
    host: hostIdentity(hostOverrides),
    location: 'remote',
    channel: channel as never,
    release: release(),
  });
}

describe('remote host identity detection', () => {
  it('declares the supported host platforms, architectures and update locations', () => {
    expect([...HOST_PLATFORMS]).toEqual(['darwin', 'linux', 'win32']);
    expect([...HOST_ARCHITECTURES]).toEqual(['x64', 'arm64']);
    expect([...UPDATE_LOCATIONS]).toEqual(['local', 'wsl', 'remote', 'slurm-compute']);
    expect([...BOOTSTRAP_ACTIONS]).toEqual(expect.arrayContaining(['connect', 'install', 'upgrade']));
  });

  it('records OS, arch, protocol and the stable environment id before any artifact', () => {
    const host = hostIdentity();
    expect(host).toEqual({
      transportKind: 'ssh',
      platform: 'linux',
      arch: 'x64',
      protocol: BRIDGE_PROTOCOL_GENERATION,
      environmentId: HOST_ENV,
      bridgeInstalled: true,
      bridgeVersion: '0.8.0',
      hostname: null,
    });
  });

  it('fails closed on an unsupported platform or architecture', () => {
    expect(() => hostIdentity({ platform: 'plan9' })).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
    expect(() => hostIdentity({ arch: 'ia32' })).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  });

  it('probes the host through the profile transport, never from a URL', async () => {
    const seen: unknown[] = [];
    const profile = sshProfile();
    const host = await probeHostIdentity({
      profile,
      probe: async (received: unknown) => {
        seen.push(received);
        return rawHost();
      },
    });
    // The probe received the profile (the transport contract), not the endpoint string.
    expect(seen).toEqual([profile]);
    expect(host.transportKind).toBe('ssh');
    expect(host.platform).toBe('linux');
  });
});

describe('update location is decided by host identity, not the URL', () => {
  it('resolves a loopback-looking SSH endpoint to a remote location', () => {
    // The profile endpoint is 127.0.0.1:2222, which no URL heuristic may treat as local.
    const host = hostIdentity();
    expect(resolveUpdateLocation({ host, localEnvironmentId: LOCAL_ENV, localPlatform: 'linux' })).toBe('remote');
  });

  it('resolves a local profile on the same environment to the local location', () => {
    const host = parseHostIdentity({ transportKind: 'local', ...rawHost({ environmentId: LOCAL_ENV }) });
    expect(resolveUpdateLocation({ host, localEnvironmentId: LOCAL_ENV, localPlatform: 'linux' })).toBe('local');
  });

  it('resolves a linux bridge under a Windows client to the wsl location', () => {
    const host = parseHostIdentity({ transportKind: 'direct', ...rawHost({ environmentId: LOCAL_ENV, platform: 'linux' }) });
    expect(resolveUpdateLocation({ host, localEnvironmentId: LOCAL_ENV, localPlatform: 'win32' })).toBe('wsl');
  });

  it('resolves a Slurm cluster profile to the slurm-compute location', () => {
    const host = parseHostIdentity({ transportKind: 'slurm', ...rawHost() });
    expect(resolveUpdateLocation({ host, localEnvironmentId: LOCAL_ENV, localPlatform: 'linux' })).toBe('slurm-compute');
  });

  it('rejects a host whose probed environment disagrees with the profile target', () => {
    expect(() => createBootstrapPlan({
      profile: sshProfile('99999999-9999-4999-8999-999999999999'),
      host: hostIdentity(),
      localEnvironmentId: LOCAL_ENV,
    })).toThrow(expect.objectContaining({ code: 'conflict' }));
  });
});

describe('a remote loopback target receives no local installer', () => {
  it('routes a loopback SSH target through the transport channel, not the local installer', () => {
    const plan = createBootstrapPlan({
      profile: sshProfile(),
      host: hostIdentity(),
      localEnvironmentId: LOCAL_ENV,
      localPlatform: 'linux',
    });
    expect(plan.location).toBe('remote');
    expect(plan.channel).toBe('transport');
    expect(plan.deliverLocalInstaller).toBe(false);
    expect(plan.localInstallerPath).toBeNull();
    expect(() => assertNoLocalInstallerForRemote(plan)).not.toThrow();
  });

  it('rejects a remote plan that claims the local installer channel', () => {
    expect(() => assertNoLocalInstallerForRemote({ location: 'remote', channel: 'local-installer' })).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
    expect(() => assertNoLocalInstallerForRemote({ location: 'slurm-compute', channel: 'local-installer' })).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  });

  it('uses the local installer for a genuine local profile', () => {
    const localHost = parseHostIdentity({ transportKind: 'local', ...rawHost({ environmentId: LOCAL_ENV }) });
    const plan = createBootstrapPlan({
      profile: {
        ...sshProfile(LOCAL_ENV),
        transport: { kind: 'local' },
        target: { kind: 'local', environmentId: LOCAL_ENV },
        role: 'local',
      },
      host: localHost,
      localEnvironmentId: LOCAL_ENV,
      localPlatform: 'linux',
    });
    expect(plan.location).toBe('local');
    expect(plan.channel).toBe('local-installer');
    expect(plan.deliverLocalInstaller).toBe(true);
  });
});

describe('incompatible versions surface the upgrade path before connecting', () => {
  it('marks an older remote bridge incompatible and returns an upgrade path instead of connecting', () => {
    const host = hostIdentity({ protocol: 'v070-legacy', bridgeVersion: '0.7.10' });
    const plan = createBootstrapPlan({
      profile: sshProfile(),
      host,
      localEnvironmentId: LOCAL_ENV,
      localPlatform: 'linux',
    });
    expect(plan.connectable).toBe(false);
    expect(plan.action).toBe('upgrade');
    expect(plan.upgradePath).toEqual(expect.objectContaining({
      action: 'upgrade',
      fromVersion: '0.7.10',
      platform: 'linux',
      arch: 'x64',
      requiredProtocol: BRIDGE_PROTOCOL_GENERATION,
    }));
    expect(plan.automatic).toBe(false);
  });

  it('recommends an install (not an upgrade) when the host has no bridge yet', () => {
    const host = hostIdentity({ protocol: null, bridgeInstalled: false, bridgeVersion: null });
    const compatibility = evaluateBridgeCompatibility({ host });
    expect(compatibility.compatible).toBe(false);
    expect(compatibility.upgradePath).toMatchObject({ action: 'install' });
    const plan = createBootstrapPlan({ profile: sshProfile(), host, localEnvironmentId: LOCAL_ENV });
    expect(plan.action).toBe('install');
    expect(plan.connectable).toBe(false);
  });

  it('connects only when the host protocol matches and never installs on mere reachability', () => {
    const plan = createBootstrapPlan({
      profile: sshProfile(),
      host: hostIdentity(),
      localEnvironmentId: LOCAL_ENV,
    });
    expect(plan.connectable).toBe(true);
    expect(plan.action).toBe('connect');
    expect(plan.automatic).toBe(false);
    expect(plan.upgradePath).toBeNull();
  });
});

describe('remote install planning reuses the release origin and hash policy', () => {
  it('declares the install channels, the remote subset and the backup targets', () => {
    expect([...INSTALL_CHANNELS]).toEqual(
      expect.arrayContaining(['local-installer', 'transport', 'slurm-shared-root', 'slurm-controlled-channel']),
    );
    expect([...REMOTE_CHANNELS]).toEqual(['transport', 'slurm-shared-root', 'slurm-controlled-channel']);
  });

  it('selects the host-native asset and SHA-256 using the existing update policy', () => {
    const artifact = selectRemoteArtifact({ release: release(), host: hostIdentity(), linuxFormat: 'deb' });
    expect(artifact.name).toBe('VisBridge-0.8.0-x64-Linux.deb');
    expect(artifact.sha256).toBe('a'.repeat(64));
    expect(artifact.url).toBe(ASSET_URL);
    expect(artifact.platform).toBe('linux');
    expect(artifact.arch).toBe('x64');
  });

  it('fails when the release has no asset for the detected host architecture', () => {
    expect(() => selectRemoteArtifact({
      release: release('0.8.0', 'arm64', 'b'),
      host: hostIdentity({ arch: 'x64' }),
    })).toThrow();
  });

  it('refuses a local installer channel for a remote location', () => {
    expect(() => planRemoteInstall({
      host: hostIdentity(),
      location: 'remote',
      channel: 'local-installer' as never,
      release: release(),
    })).toThrow(expect.objectContaining({ code: 'unsupported' }));
  });

  it('marks remote plans as explicit, atomic and non-local', () => {
    const plan = installPlan();
    expect(plan.channel).toBe('transport');
    expect(plan.deliverLocalInstaller).toBe(false);
    expect(plan.atomicSwitch).toBe(true);
    expect(plan.requiresExplicitAction).toBe(true);
    expect(plan.backup).toEqual(['program', 'database']);
  });
});

describe('remote install transaction preserves the old program and DB backup', () => {
  function adapter(overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    return {
      calls,
      download: vi.fn(async () => 'staged-1'),
      verify: vi.fn(async () => true),
      backup: vi.fn(async (_host: unknown, target: string) => {
        calls.push(`backup:${target}`);
        return `${target}-ref`;
      }),
      atomicSwitch: vi.fn(async () => { calls.push('switch'); }),
      restore: vi.fn(async (_host: unknown, target: string) => { calls.push(`restore:${target}`); }),
      discard: vi.fn(async () => { calls.push('discard'); }),
      ...overrides,
    };
  }

  it('backs up program and database before an atomic switch and reports them on success', async () => {
    const a = adapter();
    const tx = createRemoteInstallTransaction({ host: hostIdentity(), plan: installPlan(), adapter: a });
    const receipt = await tx.upgrade();
    expect(a.calls).toEqual(['backup:program', 'backup:database', 'switch']);
    expect(receipt).toMatchObject({ action: 'upgrade', switched: true, rolledBack: false, databasePreserved: true });
    expect(receipt.backups).toEqual({ program: 'program-ref', database: 'database-ref' });
  });

  it('rolls the program back but keeps the database backup when the atomic switch fails', async () => {
    const a = adapter({
      atomicSwitch: vi.fn(async () => { throw new Error('dpkg failed'); }),
    });
    // keep the call trace from the base adapter for switch ordering
    a.atomicSwitch = vi.fn(async () => { a.calls.push('switch'); throw new Error('dpkg failed'); });
    const tx = createRemoteInstallTransaction({ host: hostIdentity(), plan: installPlan(), adapter: a });
    await expect(tx.upgrade()).rejects.toThrow('dpkg failed');
    // A failed switch rolls the program back AND releases the never-delivered staged package.
    expect(a.calls).toEqual(['backup:program', 'backup:database', 'switch', 'restore:program', 'discard']);
    // The database backup is never destroyed as part of a program rollback.
    expect(a.restore).not.toHaveBeenCalledWith(expect.anything(), 'database', expect.anything());
    const receipt = tx.receipt();
    expect(receipt).toMatchObject({ switched: false, rolledBack: true, databasePreserved: true });
    expect(receipt.backups.database).toBe('database-ref');
  });

  it('discards a staged artifact that fails hash verification without touching the old install', async () => {
    const a = adapter({ verify: vi.fn(async () => false) });
    const tx = createRemoteInstallTransaction({ host: hostIdentity(), plan: installPlan(), adapter: a });
    await expect(tx.install()).rejects.toMatchObject({ code: 'conflict' });
    expect(a.discard).toHaveBeenCalledWith('staged-1');
    expect(a.backup).not.toHaveBeenCalled();
    expect(a.atomicSwitch).not.toHaveBeenCalled();
  });
});

describe('remote install releases the staged package on every failure path', () => {
  type FailureScenario =
    | 'verify-throws'
    | 'verify-false'
    | 'program-backup-fails'
    | 'database-backup-fails'
    | 'atomic-switch-fails'
    | 'discard-fails';

  function stagedAdapter(dir: string, scenario: FailureScenario) {
    const counts = { discard: 0, restore: 0 };
    const stagedPath = path.join(dir, 'VisBridge-0.8.0-x64-Linux.deb');
    const adapter = {
      download: async () => {
        await writeFile(stagedPath, 'staged-package-bytes');
        return stagedPath;
      },
      verify: async () => {
        if (scenario === 'verify-throws') throw new Error('verify exploded');
        return scenario !== 'verify-false' && scenario !== 'discard-fails';
      },
      backup: async (_host: unknown, target: string) => {
        if (scenario === 'program-backup-fails' && target === 'program') throw new Error('program backup failed');
        if (scenario === 'database-backup-fails' && target === 'database') throw new Error('database backup failed');
        return `${target}-ref`;
      },
      atomicSwitch: async () => {
        if (scenario === 'atomic-switch-fails') throw new Error('atomic switch failed');
      },
      restore: async () => { counts.restore += 1; },
      discard: async (staged: unknown) => {
        counts.discard += 1;
        if (scenario === 'discard-fails') throw new Error('discard exploded');
        await rm(String(staged), { force: true });
      },
    };
    return { adapter, counts };
  }

  async function runFailure(scenario: FailureScenario, action: 'install' | 'upgrade' = 'upgrade') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vis-remote-install-'));
    try {
      const { adapter, counts } = stagedAdapter(dir, scenario);
      const tx = createRemoteInstallTransaction({ host: hostIdentity(), plan: installPlan(), adapter });
      const rejection = await (action === 'upgrade' ? tx.upgrade() : tx.install())
        .then(() => null, (error: unknown) => error);
      const observedStagedEntries = (await readdir(dir)).length;
      return { rejection, counts, observedStagedEntries };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('releases the staged package when verify throws', async () => {
    const { rejection, counts, observedStagedEntries } = await runFailure('verify-throws', 'install');
    expect((rejection as Error).message).toBe('verify exploded');
    expect(counts.discard).toBe(1);
    expect(observedStagedEntries).toBe(0);
  });

  it('releases the staged package when verify returns false', async () => {
    const { rejection, counts, observedStagedEntries } = await runFailure('verify-false', 'install');
    expect(rejection).toMatchObject({ code: 'conflict' });
    expect(counts.discard).toBe(1);
    expect(observedStagedEntries).toBe(0);
  });

  it('releases the staged package when the program backup fails', async () => {
    const { rejection, counts, observedStagedEntries } = await runFailure('program-backup-fails');
    expect((rejection as Error).message).toBe('program backup failed');
    expect(counts.discard).toBe(1);
    expect(observedStagedEntries).toBe(0);
  });

  it('releases the staged package when the database backup fails', async () => {
    const { rejection, counts, observedStagedEntries } = await runFailure('database-backup-fails');
    expect((rejection as Error).message).toBe('database backup failed');
    expect(counts.discard).toBe(1);
    expect(observedStagedEntries).toBe(0);
  });

  it('releases the staged package after a failed atomic switch and rollback', async () => {
    const { rejection, counts, observedStagedEntries } = await runFailure('atomic-switch-fails');
    expect((rejection as Error).message).toBe('atomic switch failed');
    expect(counts.restore).toBe(1);
    expect(counts.discard).toBe(1);
    expect(observedStagedEntries).toBe(0);
  });

  it('keeps the original failure when the cleanup discard itself fails', async () => {
    const { rejection, counts } = await runFailure('discard-fails', 'install');
    expect(rejection).toMatchObject({ code: 'conflict' });
    expect(counts.discard).toBe(1);
  });
});

describe('Slurm compute artifact delivery', () => {
  function slurmHost(overrides: Record<string, unknown> = {}) {
    return parseHostIdentity({ transportKind: 'slurm', ...rawHost({ arch: 'arm64', ...overrides }) });
  }

  it('chooses the shared root when available and the controlled channel otherwise', () => {
    const shared = createBootstrapPlan({
      profile: { ...sshProfile(), transport: { kind: 'slurm' }, target: { kind: 'slurm', clusterEnvironmentId: HOST_ENV }, role: 'manager' },
      host: slurmHost(),
      localEnvironmentId: LOCAL_ENV,
      sharedRootAvailable: true,
    });
    expect(shared.location).toBe('slurm-compute');
    expect(shared.channel).toBe('slurm-shared-root');
    expect(shared.deliverLocalInstaller).toBe(false);

    const controlled = createBootstrapPlan({
      profile: { ...sshProfile(), transport: { kind: 'slurm' }, target: { kind: 'slurm', clusterEnvironmentId: HOST_ENV }, role: 'manager' },
      host: slurmHost(),
      localEnvironmentId: LOCAL_ENV,
      sharedRootAvailable: false,
    });
    expect(controlled.channel).toBe('slurm-controlled-channel');
    expect(controlled.deliverLocalInstaller).toBe(false);
  });

  it('selects the compute-native artifact and never the local installer', () => {
    const shared = planRemoteInstall({
      host: slurmHost(),
      location: 'slurm-compute',
      channel: 'slurm-shared-root',
      release: release('0.8.0', 'arm64', 'c'),
      sharedRootAvailable: true,
    });
    expect(shared.artifact.name).toBe('VisBridge-0.8.0-arm64-Linux.deb');
    expect(shared.deliverLocalInstaller).toBe(false);
    expect(() => planRemoteInstall({
      host: slurmHost(),
      location: 'slurm-compute',
      channel: 'local-installer' as never,
      release: release('0.8.0', 'arm64', 'c'),
    })).toThrow(expect.objectContaining({ code: 'unsupported' }));
  });
});

describe('host install path and local-installer location guard', () => {
  it('resolves the managed install path from the probed host platform', () => {
    expect(hostInstallPath({ platform: 'linux' })).toBe('/usr/bin/vis_bridge');
    expect(hostInstallPath({ platform: 'darwin' })).toBe('/usr/local/bin/vis_bridge');
    expect(hostInstallPath({ platform: 'win32' }, { LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` }))
      .toBe(path.win32.join(String.raw`C:\Users\me\AppData\Local`, 'Programs', 'vis_bridge', 'vis_bridge.exe'));
  });

  it('rejects an unsupported host platform', () => {
    expect(() => hostInstallPath({ platform: 'plan9' })).toThrow(/Unsupported/);
  });

  it('allows the local installer only for the local location', () => {
    expect(assertLocalInstallerLocation('local')).toBe('local');
    expect(() => assertLocalInstallerLocation('remote')).toThrow(/local installer/);
    expect(() => assertLocalInstallerLocation('slurm-compute')).toThrow(/local installer/);
    expect(() => assertLocalInstallerLocation('nowhere')).toThrow(/Unknown/);
  });
});

describe('host-aware daemon invocation', () => {
  it('runs the daemon from the host install path, never the local execPath', () => {
    const invocation = createDaemonInvocation({
      entryPath: '/repo/vis_bridge.js',
      execPath: '/usr/bin/node',
      serverArgs: ['--port', '1'],
      hostInstallPath: '/usr/bin/vis_bridge',
    });
    expect(invocation).toEqual({ command: '/usr/bin/vis_bridge', args: ['__daemon', '--port', '1'] });
  });

  it('keeps the existing local source/SEA selection without a host path', () => {
    expect(createDaemonInvocation({
      entryPath: '/repo/vis_bridge.js',
      execPath: '/usr/bin/node',
      serverArgs: [],
      isSea: false,
    })).toEqual({ command: '/usr/bin/node', args: ['/repo/vis_bridge.js', '__daemon'] });
  });
});

describe('explicit remote update action', () => {
  function collectingAdapter() {
    const calls: string[] = [];
    return {
      calls,
      download: vi.fn(async () => 'staged'),
      verify: vi.fn(async () => true),
      backup: vi.fn(async (_host: unknown, target: string) => {
        calls.push(`backup:${target}`);
        return `${target}-ref`;
      }),
      atomicSwitch: vi.fn(async () => { calls.push('switch'); }),
      restore: vi.fn(async () => { calls.push('restore'); }),
      discard: vi.fn(async () => {}),
    };
  }

  it('returns current for a compatible check and never installs', async () => {
    const result = await runRemoteBridgeUpdate(
      { profile: sshProfile(), host: hostIdentity(), localEnvironmentId: LOCAL_ENV, action: 'check' },
      { output: () => {} },
    );
    expect(result.kind).toBe('current');
    expect(result.plan.action).toBe('connect');
  });

  it('surfaces the upgrade path on an incompatible check without installing', async () => {
    const result = await runRemoteBridgeUpdate(
      {
        profile: sshProfile(),
        host: hostIdentity({ protocol: 'v070-legacy', bridgeVersion: '0.7.10' }),
        localEnvironmentId: LOCAL_ENV,
        action: 'check',
      },
      { output: () => {} },
    );
    expect(result.kind).toBe('upgrade-required');
    expect(result.plan.action).toBe('upgrade');
    expect(result.plan.upgradePath).toMatchObject({ fromVersion: '0.7.10' });
  });

  it('runs the explicit upgrade transaction through the injected adapter', async () => {
    const adapter = collectingAdapter();
    const result = await runRemoteBridgeUpdate(
      {
        profile: sshProfile(),
        host: hostIdentity({ protocol: 'v070-legacy', bridgeVersion: '0.7.10' }),
        localEnvironmentId: LOCAL_ENV,
        action: 'upgrade',
        release: release(),
      },
      { output: () => {}, adapter },
    );
    expect(result.kind).toBe('installed');
    expect(adapter.calls).toEqual(['backup:program', 'backup:database', 'switch']);
  });
});
