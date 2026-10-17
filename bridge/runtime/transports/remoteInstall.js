import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { selectBridgeAsset, sha256FromDigest } from '../../../electron/updatePolicy.js';

/**
 * Remote Bridge install/update transaction.
 *
 * Reuse, not reinvention: the release *origin* and SHA-256 selection come straight from the existing
 * `electron/updatePolicy.js` (the same policy the desktop updater and `bridge/updateCli.js` use).
 * The transaction then performs the classic temp-install / atomic-switch / rollback dance, and it
 * always keeps a program *and* a database backup so an old install and its data survive.
 *
 * A remote target never uses the local installer: its artifact travels through the task-26 transport
 * (SSH forward / relay). A Slurm compute artifact travels first through a shared root or a controlled
 * channel. `local-installer` is reserved for a genuine same-environment local target.
 */
export const INSTALL_CHANNELS = Object.freeze([
  'local-installer',
  'wsl-terminal',
  'transport',
  'slurm-shared-root',
  'slurm-controlled-channel',
]);
/** Channels that deliver through the transport layer, never through the local installer handoff. */
export const REMOTE_CHANNELS = Object.freeze(['transport', 'slurm-shared-root', 'slurm-controlled-channel']);
export const BACKUP_TARGETS = Object.freeze(['program', 'database']);
const SLURM_CHANNELS = Object.freeze(['slurm-shared-root', 'slurm-controlled-channel']);

const defaultPolicy = Object.freeze({ selectBridgeAsset, sha256FromDigest });

/**
 * Selects the host-native release asset and its expected SHA-256 using the existing policy. The host
 * platform/arch — never a URL — drive the choice, so the wrong architecture fails closed in policy.
 */
export function selectRemoteArtifact(options) {
  const host = options.host;
  requireValue(host !== null && typeof host === 'object', 'host');
  const policy = options.policy ?? defaultPolicy;
  const linuxFormat = options.linuxFormat ?? 'deb';
  const asset = policy.selectBridgeAsset(options.release, host.platform, host.arch, linuxFormat);
  const sha256 = policy.sha256FromDigest(asset);
  return Object.freeze({
    name: asset.name,
    size: asset.size,
    url: asset.url,
    sha256,
    platform: host.platform,
    arch: host.arch,
    linuxFormat: host.platform === 'linux' ? linuxFormat : null,
  });
}

/**
 * Builds the explicit install plan for a probed host. `local-installer` is rejected for every
 * non-local target, and a Slurm compute host may only use the shared-root or controlled channel.
 */
export function planRemoteInstall(options) {
  const host = options.host;
  requireValue(host !== null && typeof host === 'object', 'host');
  const location = options.location;
  const channel = options.channel;
  requireValue(INSTALL_CHANNELS.includes(channel), 'channel', 'unsupported');
  requireValue(!(location !== 'local' && channel === 'local-installer'), 'channel.localInstaller', 'unsupported');
  if (location === 'slurm-compute') {
    requireValue(SLURM_CHANNELS.includes(channel), 'channel', 'unsupported');
  }
  const artifact = selectRemoteArtifact({
    release: options.release,
    host,
    linuxFormat: options.linuxFormat,
    policy: options.policy,
  });
  return Object.freeze({
    hostEnvironmentId: host.environmentId,
    location,
    channel,
    deliverLocalInstaller: channel === 'local-installer',
    atomicSwitch: true,
    requiresExplicitAction: true,
    backup: [...BACKUP_TARGETS],
    artifact,
  });
}

/**
 * Runs the explicit install/upgrade transaction against injected host operations. The orchestration
 * guarantees the ordering the acceptance criteria name: download and verify first, back up the old
 * program and database, then atomically switch. Any later failure rolls the *program* back and keeps
 * the database backup intact.
 */
export function createRemoteInstallTransaction(options) {
  const host = options.host;
  const plan = options.plan;
  const adapter = options.adapter;
  requireValue(plan !== null && typeof plan === 'object', 'plan');
  requireValue(plan.requiresExplicitAction === true, 'plan.explicit', 'unsupported');
  requireValue(adapter !== null && typeof adapter === 'object', 'adapter');

  const state = { action: null, switched: false, rolledBack: false };
  let programBackup = null;
  let databaseBackup = null;

  function receipt() {
    return Object.freeze({
      action: state.action,
      switched: state.switched,
      rolledBack: state.rolledBack,
      databasePreserved: true,
      backups: Object.freeze({ program: programBackup, database: databaseBackup }),
    });
  }

  async function rollback() {
    // A program-only rollback: the database backup is deliberately preserved, never discarded.
    if (programBackup !== null) {
      await adapter.restore(host, 'program', programBackup);
      state.switched = false;
    }
    state.rolledBack = true;
    return receipt();
  }

  async function install(action) {
    state.action = action;
    const staged = await adapter.download(plan);
    let stagedReleased = false;
    async function releaseStaged() {
      if (stagedReleased) return;
      stagedReleased = true;
      try {
        await adapter.discard(staged);
      } catch {
        // Cleanup is best-effort: releasing the staged package must never mask the install failure.
      }
    }
    try {
      const verified = await adapter.verify(staged, plan);
      if (verified !== true) {
        throw new ProtocolError('conflict', 'artifact.sha256');
      }
      programBackup = await adapter.backup(host, 'program', plan);
      databaseBackup = await adapter.backup(host, 'database', plan);
      try {
        await adapter.atomicSwitch(host, staged, plan);
        state.switched = true;
      } catch (error) {
        await rollback();
        throw error;
      }
      return receipt();
    } catch (error) {
      await releaseStaged();
      throw error;
    }
  }

  return Object.freeze({
    install: () => install('install'),
    upgrade: () => install('upgrade'),
    rollback,
    receipt,
  });
}
