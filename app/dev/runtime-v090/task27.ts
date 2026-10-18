// Task 27 registered QA browser entry — the renderer-shaped surface of the remote
// bridge bootstrap / update decision.
//
// Loaded by scripts/qa/runtime-v090-cases/task-27.mjs from a runner-served page and
// driven by a real headless Chromium. The REAL landed code executes here:
//   * bridge/runtime/transports/remoteBootstrap.js — the pure, browser-safe host
//     identity / update-location / upgrade-path rules the runtime UI reuses
//     (parseHostIdentity, createBootstrapPlan, resolveUpdateLocation,
//     BRIDGE_PROTOCOL_GENERATION);
//   * app/composables/useConnectedBridgeVersion.ts — the real /healthz probe that
//     surfaces the upgradePath BEFORE a connection is established;
//   * app/composables/useDesktopBridgeVersion.ts — the real endpoint-locality
//     decision, where a managed SSH/Slurm host is remote even when its health URL is
//     a loopback address ("the host identity, not the URL, decides where an update is
//     applied").
//
// The only controlled boundary is scripts/qa/runtime-v090-cases/task-27-registry-stub.mjs,
// which backs the one registry symbol the desktop composable imports so the surface
// stays hermetic (the backend-adapter barrel is not what this case tests).
//
// This entry never contacts a live SSH host and never contacts a live release
// origin; task 46 owns the live end-to-end verification. It authors no PASS verdict.
import { effectScope, nextTick, ref } from 'vue';

import {
  BRIDGE_PROTOCOL_GENERATION,
  createBootstrapPlan,
  parseHostIdentity,
  resolveUpdateLocation,
} from '../../../bridge/runtime/transports/remoteBootstrap.js';
import {
  classifyDesktopBridgeEndpoint,
  useDesktopBridgeVersion,
} from '../../composables/useDesktopBridgeVersion';
import { useConnectedBridgeVersion } from '../../composables/useConnectedBridgeVersion';

type AnyRecord = Record<string, any>;

const LOCAL_ENV = '11111111-1111-4111-8111-111111111111';
const HOST_ENV = '22222222-2222-4222-8222-222222222222';
const LOOPBACK_ENDPOINT = '127.0.0.1:2222';

// ── observation channels ────────────────────────────────────────────────────────────────────
const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => {
  errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`);
});

const consoleEntries: Array<{ level: string; text: string }> = [];
function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { consoleEntries.push({ level, text: args.map(safeString).join(' ') }); } catch { /* capture never throws */ }
    original(...args);
  };
}

const domHost = document.createElement('pre');
domHost.id = 'qa27-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

const occurrences = (haystack: string, needle: string): number => (needle.length === 0 ? 0 : String(haystack).split(needle).length - 1);

function sshProfile(environmentId: string): AnyRecord {
  return Object.freeze({
    profileId: '55555555-5555-4555-8555-555555555555',
    name: 'Build host',
    transport: Object.freeze({ kind: 'ssh', endpoint: LOOPBACK_ENDPOINT }),
    target: Object.freeze({ kind: 'ssh', environmentId }),
    role: 'execution',
    credentialRef: 'cred-ssh',
    enabled: true,
  });
}

// ── BH1: the pure bootstrap rules a renderer reuses (criterion 1 + 2 + 4) ─────────────────────
function bootstrapRules(): AnyRecord {
  const compatible = parseHostIdentity({
    transportKind: 'ssh', platform: 'linux', arch: 'x64',
    protocol: BRIDGE_PROTOCOL_GENERATION, environmentId: HOST_ENV, bridgeInstalled: true, bridgeVersion: '0.8.0',
  });
  const stale = parseHostIdentity({
    transportKind: 'ssh', platform: 'linux', arch: 'x64',
    protocol: 'v070-legacy', environmentId: HOST_ENV, bridgeInstalled: true, bridgeVersion: '0.7.10',
  });
  const plan = createBootstrapPlan({
    profile: sshProfile(HOST_ENV), host: compatible,
    localEnvironmentId: LOCAL_ENV, localPlatform: 'linux',
  });
  const stalePlan = createBootstrapPlan({
    profile: sshProfile(HOST_ENV), host: stale,
    localEnvironmentId: LOCAL_ENV, localPlatform: 'linux',
  });
  const directLocal = parseHostIdentity({
    transportKind: 'direct', platform: 'linux', arch: 'x64',
    protocol: BRIDGE_PROTOCOL_GENERATION, environmentId: LOCAL_ENV,
  });
  const result = {
    endpoint: LOOPBACK_ENDPOINT,
    location: plan.location,
    channel: plan.channel,
    deliverLocalInstaller: plan.deliverLocalInstaller,
    localInstallerPath: plan.localInstallerPath,
    connectable: plan.connectable,
    action: plan.action,
    automatic: plan.automatic,
    staleConnectable: stalePlan.connectable,
    staleAction: stalePlan.action,
    upgradeAction: (stalePlan.upgradePath as AnyRecord).action,
    upgradeFromVersion: (stalePlan.upgradePath as AnyRecord).fromVersion,
    upgradeRequiredProtocol: (stalePlan.upgradePath as AnyRecord).requiredProtocol,
    wslLocation: resolveUpdateLocation({ host: directLocal, localEnvironmentId: LOCAL_ENV, localPlatform: 'win32' }),
    // the location decision reads host identity/profile; a URL is never an input.
    urlTokensInResolver: occurrences(String(resolveUpdateLocation), 'url'),
  };
  domHost.textContent = JSON.stringify(result);
  return { ...result, domLength: (domHost.textContent ?? '').length };
}

// ── BH2: the /healthz probe surfaces the upgrade path before connecting (criterion 4) ─────────
async function waitSettled(read: () => string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = read();
    if (status !== 'loading') return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return 'timeout';
}

async function probeHealth(url: string, minimumVersion?: string): Promise<AnyRecord> {
  const scope = effectScope(true);
  let api: ReturnType<typeof useConnectedBridgeVersion> | null = null;
  scope.run(() => {
    api = useConnectedBridgeVersion(ref(url), minimumVersion === undefined ? undefined : { minimumVersion });
  });
  const connected = api as unknown as ReturnType<typeof useConnectedBridgeVersion>;
  const status = await waitSettled(() => connected.state.value.status);
  await nextTick();
  const state = connected.state.value;
  const upgrade = connected.upgradePath.value;
  domHost.textContent = JSON.stringify({ status, state, upgrade });
  const result = {
    status,
    version: state.status === 'ready' ? state.version : null,
    upgradeAction: upgrade === null ? null : upgrade.action,
    upgradeFromVersion: upgrade === null ? null : upgrade.fromVersion,
    upgradeRequiredVersion: upgrade === null ? null : upgrade.requiredVersion,
  };
  scope.stop();
  return result;
}

// ── BH3: host identity, not the URL, decides the update location (criterion 2) ────────────────
async function probeLocality(url: string, transportKind: string): Promise<AnyRecord> {
  const reports: AnyRecord[] = [];
  const desktopApi = {
    reportBridgeVersion: async (payload: AnyRecord) => { reports.push(payload); return undefined; },
  };
  const hostIdentity = ref({ transportKind });
  const scope = effectScope(true);
  scope.run(() => {
    useDesktopBridgeVersion(ref(url), desktopApi as never, { hostIdentity: hostIdentity as never });
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && reports.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  await nextTick();
  const last = reports[reports.length - 1] ?? null;
  domHost.textContent = JSON.stringify({ transportKind, reports });
  const result = {
    transportKind,
    reportCount: reports.length,
    reportEndpointLocality: last === null ? null : last.endpointLocality,
    reportVersion: last === null ? null : last.version,
    reportHasConnectionId: last === null ? false : typeof last.connectionId === 'string' && last.connectionId.length > 0,
    urlLocality: classifyDesktopBridgeEndpoint(url),
  };
  scope.stop();
  return result;
}

const api = {
  ready: true,
  constants: { LOCAL_ENV, HOST_ENV, LOOPBACK_ENDPOINT, BRIDGE_PROTOCOL_GENERATION },
  errors: () => errors,
  consoleEntries: () => consoleEntries.map((entry) => ({ ...entry })),
  domText: () => `${document.body.innerText}\n${domHost.textContent ?? ''}`,
  bootstrapRules,
  probeHealth,
  probeLocality,
};

(window as unknown as AnyRecord).task27 = api;
