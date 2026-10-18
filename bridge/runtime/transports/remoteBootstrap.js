import { ProtocolError, objectFields, requireValue, textValue } from '../../../shared/runtime/capabilities.js';
import { parseEnvironmentId } from '../../../shared/runtime/identity.js';
import { TRANSPORT_KINDS, resolveProfileEnvironment } from '../../../shared/runtime/connectionProfile.js';

/**
 * Remote Bridge bootstrap probe. Pure and browser-safe (no `node:` imports) so the runtime UI can
 * reuse the same host-identity and upgrade-path rules as the bridge.
 *
 * The rules this module owns (plan task 27 / Scope 12):
 *  - a probe records the host OS/arch/protocol/stable environment id *before* any artifact is picked;
 *  - the update location is derived from the host identity/profile, never from a connection URL
 *    (a loopback URL to a remote host is still remote);
 *  - an incompatible bridge surfaces the correct install/upgrade path *before* a connection is made;
 *  - install/upgrade are always explicit; a plan never performs them on mere reachability.
 */
export const HOST_PLATFORMS = Object.freeze(['darwin', 'linux', 'win32']);
export const HOST_ARCHITECTURES = Object.freeze(['x64', 'arm64']);
/** Where an update is applied. `slurm-compute` artifacts travel by shared root or controlled channel. */
export const UPDATE_LOCATIONS = Object.freeze(['local', 'wsl', 'remote', 'slurm-compute']);
/** Protocol generation this runtime speaks; a host at another generation must be upgraded first. */
export const BRIDGE_PROTOCOL_GENERATION = 'v090-runtime';
export const BOOTSTRAP_ACTIONS = Object.freeze(['connect', 'install', 'upgrade']);

const HOST_FIELDS = Object.freeze(['transportKind', 'platform', 'arch', 'environmentId']);
const HOST_OPTIONAL_FIELDS = Object.freeze(['protocol', 'bridgeInstalled', 'bridgeVersion', 'hostname']);

/**
 * Normalizes a probed host record. `protocol` is null when no bridge is installed, which is what
 * distinguishes "install" from "upgrade" in the compatibility step.
 */
export function parseHostIdentity(input) {
  const value = objectFields(input, HOST_FIELDS, HOST_OPTIONAL_FIELDS);
  requireValue(TRANSPORT_KINDS.includes(value.transportKind), 'host.transportKind', 'unsupported');
  requireValue(HOST_PLATFORMS.includes(value.platform), 'host.platform', 'unsupported');
  requireValue(HOST_ARCHITECTURES.includes(value.arch), 'host.arch', 'unsupported');
  const protocol = value.protocol === undefined || value.protocol === null
    ? null
    : textValue(value.protocol, 'host.protocol');
  const bridgeInstalled = value.bridgeInstalled === true;
  const bridgeVersion = value.bridgeVersion === undefined || value.bridgeVersion === null
    ? null
    : textValue(value.bridgeVersion, 'host.bridgeVersion');
  const hostname = value.hostname === undefined || value.hostname === null
    ? null
    : textValue(value.hostname, 'host.hostname');
  return Object.freeze({
    transportKind: value.transportKind,
    platform: value.platform,
    arch: value.arch,
    protocol,
    environmentId: parseEnvironmentId(value.environmentId),
    bridgeInstalled,
    bridgeVersion,
    hostname,
  });
}

/**
 * Runs the caller-supplied probe (which reads the host over the task-26 transport channel) and
 * normalizes the result. The profile — not the endpoint string — is handed to the probe, so the
 * probe can never silently fall back to a URL heuristic.
 */
export async function probeHostIdentity(options) {
  const profile = options?.profile;
  requireValue(profile !== null && typeof profile === 'object', 'profile');
  requireValue(profile.transport !== null && typeof profile.transport === 'object', 'profile.transport');
  requireValue(typeof options.probe === 'function', 'probe');
  const raw = await options.probe(profile);
  requireValue(raw !== null && typeof raw === 'object', 'probe.result');
  return parseHostIdentity({ ...raw, transportKind: profile.transport.kind });
}

/**
 * The update location from the host identity/profile. This function has no URL parameter by design:
 * a `127.0.0.1` endpoint of an SSH/Slurm profile is still remote.
 */
export function resolveUpdateLocation(options) {
  const host = options?.host;
  requireValue(host !== null && typeof host === 'object', 'host');
  const localEnvironmentId = parseEnvironmentId(options.localEnvironmentId);
  const localPlatform = options.localPlatform ?? host.platform;
  if (host.transportKind === 'slurm') return 'slurm-compute';
  if (host.transportKind === 'ssh') return 'remote';
  if (host.environmentId !== localEnvironmentId) return 'remote';
  if (host.transportKind === 'direct' && host.platform === 'linux' && localPlatform === 'win32') return 'wsl';
  return 'local';
}

/**
 * Whether a host's bridge can be connected now, and if not, the correct install/upgrade path to
 * surface *before* connecting. A host with no bridge needs `install`; a host on a different
 * protocol generation needs `upgrade`.
 */
export function evaluateBridgeCompatibility(options) {
  const host = options?.host;
  requireValue(host !== null && typeof host === 'object', 'host');
  const requiredProtocol = options.requiredProtocol ?? BRIDGE_PROTOCOL_GENERATION;
  const compatible = host.protocol !== null && host.protocol === requiredProtocol;
  if (compatible) return Object.freeze({ compatible: true, connectable: true, upgradePath: null });
  const upgradePath = Object.freeze({
    action: host.bridgeInstalled ? 'upgrade' : 'install',
    fromVersion: host.bridgeVersion,
    platform: host.platform,
    arch: host.arch,
    environmentId: host.environmentId,
    requiredProtocol,
  });
  return Object.freeze({ compatible: false, connectable: false, upgradePath });
}

function channelFor(location, sharedRootAvailable) {
  if (location === 'local') return 'local-installer';
  if (location === 'wsl') return 'wsl-terminal';
  if (location === 'slurm-compute') {
    return sharedRootAvailable ? 'slurm-shared-root' : 'slurm-controlled-channel';
  }
  return 'transport';
}

/**
 * Builds the bootstrap decision. When the probed environment disagrees with the profile target the
 * plan fails closed: the profile is authoritative and a mismatched host is a conflict, not an update.
 * `automatic` is always false — install/upgrade require an explicit action.
 */
export function createBootstrapPlan(options) {
  const host = options?.host;
  requireValue(host !== null && typeof host === 'object', 'host');
  const profile = options.profile;
  if (profile !== undefined && profile !== null) {
    requireValue(
      resolveProfileEnvironment(profile) === host.environmentId,
      'profile.environment',
      'conflict',
    );
  }
  const location = resolveUpdateLocation({
    host,
    localEnvironmentId: options.localEnvironmentId,
    localPlatform: options.localPlatform,
  });
  const { compatible, connectable, upgradePath } = evaluateBridgeCompatibility({
    host,
    requiredProtocol: options.requiredProtocol,
  });
  const channel = channelFor(location, options.sharedRootAvailable === true);
  const action = compatible ? 'connect' : upgradePath.action;
  const plan = {
    profileId: profile?.profileId ?? null,
    environmentId: host.environmentId,
    location,
    channel,
    action,
    connectable,
    compatible,
    upgradePath,
    deliverLocalInstaller: channel === 'local-installer',
    localInstallerPath: null,
    automatic: false,
    requiresExplicitAction: action !== 'connect',
  };
  assertNoLocalInstallerForRemote(plan);
  return Object.freeze(plan);
}

/**
 * Defence in depth: no plan that is not a genuine local target may use the local installer path
 * (so a remote loopback target can never receive the local installer).
 */
export function assertNoLocalInstallerForRemote(plan) {
  const remote = plan?.location !== 'local';
  if (remote && (plan?.channel === 'local-installer' || plan?.deliverLocalInstaller === true)) {
    throw new ProtocolError('unsupported', 'plan.localInstaller');
  }
  return plan;
}
