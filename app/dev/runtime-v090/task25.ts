// Task 25 registered QA browser entry — the real profile HTTP client against a REAL bridge server.
//
// Loaded by scripts/qa/runtime-v090-cases/task-25.mjs from a runner-served page and driven by a
// real headless Chromium. The REAL landed code executes here:
//   * app/composables/useRuntimeProfiles.ts — `createBridgeProfileClient` (the exact HTTP client for
//     the task-25 profile routes), `resolveRuntimeCapabilityEntry` and `isDirectOnlyRuntime` (the
//     ONE capability entry Browser and Electron share);
//   * shared/runtime/connectionProfile.js — the REAL strict parser / target mapping / secret guard,
//     reached through the client on both the request and the response path.
//
// The browser talks to the SAME `createVisBridgeServer` listener the Node worker owns, over real
// cross-origin HTTP (a bridge token is set, so `isAllowedOrigin` accepts the Vite origin and the
// real CORS preflight path runs). The only artificial pieces are the Vite dev server that serves
// this entry and the console/DOM/storage probes; no live SSH host and no live Slurm cluster is
// contacted, and this entry authors no PASS verdict (task 46 owns the live end-to-end check).
import {
  createBridgeProfileClient,
  isDirectOnlyRuntime,
  resolveRuntimeCapabilityEntry,
} from '../../composables/useRuntimeProfiles';

type AnyRecord = Record<string, any>;

type Task25Config = Readonly<{
  baseUrl: string;
  token: string;
  secret: string;
  credentialRef: string;
  environmentId: string;
}>;

const ENVIRONMENT = '11111111-1111-4111-8111-111111111111';

const config = ((window as unknown as AnyRecord).__task25Config ?? {
  baseUrl: '',
  token: '',
  secret: '',
  credentialRef: 'cred-task25-01',
  environmentId: ENVIRONMENT,
}) as Task25Config;

// ── observation channels ────────────────────────────────────────────────────────────────────
const errors: AnyRecord[] = [];
window.addEventListener('error', (event) => { errors.push({ kind: 'error', message: String((event as ErrorEvent).message) }); });
window.addEventListener('unhandledrejection', (event) => {
  const reason = (event as PromiseRejectionEvent).reason as AnyRecord | undefined;
  errors.push({ kind: 'unhandledrejection', message: String((reason && reason.message) || reason) });
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

const occurrences = (haystack: string, needle: string): number =>
  needle.length === 0 ? 0 : String(haystack).split(needle).length - 1;

// ── the REAL client, over a recording fetch so the serialized wire payload is observable ──────
const httpCalls: AnyRecord[] = [];
const recordingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input as RequestInfo, init);
  let text = '';
  try { text = await response.clone().text(); } catch { /* a body may be opaque; keep the call */ }
  httpCalls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ?? null, status: response.status, response: text });
  return response;
};

const client = createBridgeProfileClient({
  baseUrl: config.baseUrl,
  token: config.token,
  fetchImpl: recordingFetch,
});

// A small non-empty surface so the DOM probe is meaningful: it renders the REFERENCE, never a value.
const domHost = document.createElement('pre');
domHost.id = 'task25-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);
const rendered: AnyRecord = { credentialRefs: [] as string[], environmentIds: [] as string[], profileIds: [] as string[] };
function renderProfile(profile: AnyRecord): void {
  rendered.profileIds.push(profile.profileId);
  rendered.credentialRefs.push(profile.credentialRef);
  const target = profile.target as AnyRecord;
  const environmentId = target.environmentId ?? target.clusterEnvironmentId ?? null;
  if (environmentId !== null) rendered.environmentIds.push(environmentId);
  domHost.textContent = [
    `profiles=${rendered.profileIds.length}`,
    `credentialRef=${profile.credentialRef}`,
    `environmentId=${environmentId}`,
  ].join('\n');
}

function sshDraft(overrides: AnyRecord = {}): AnyRecord {
  return {
    name: 'Browser profile',
    transport: { kind: 'ssh', endpoint: 'cluster.example:22' },
    target: { kind: 'ssh', environmentId: config.environmentId || ENVIRONMENT },
    role: 'execution',
    credentialRef: config.credentialRef,
    ...overrides,
  };
}

function serializeStorage(storage: Storage): string {
  const parts: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index) ?? '';
    parts.push(`${key}=${storage.getItem(key) ?? ''}`);
  }
  return parts.join('\n');
}

const api: AnyRecord = {
  ready: true,
  constants: {
    secret: config.secret,
    credentialRef: config.credentialRef,
    baseUrl: config.baseUrl,
    environmentId: config.environmentId || ENVIRONMENT,
  },
  errors: () => errors.map((entry) => ({ ...entry })),
  consoleEntries: () => consoleEntries.map((entry) => ({ ...entry })),
  httpCalls: () => httpCalls.map((entry) => ({ ...entry })),
  domText: () => document.body.innerText,
  rendered: () => ({ profileIds: [...rendered.profileIds], credentialRefs: [...rendered.credentialRefs], environmentIds: [...rendered.environmentIds] }),
  storageSnapshot: () => ({
    local: serializeStorage(window.localStorage),
    session: serializeStorage(window.sessionStorage),
  }),

  // Reads the profiles the Node worker created through THIS bridge, over the real HTTP client.
  async list() {
    const profiles = await client.list();
    return {
      count: profiles.length,
      ids: profiles.map((profile) => profile.profileId),
      credentialRefs: profiles.map((profile) => profile.credentialRef),
      environmentIds: profiles.map((profile) => (profile.target as AnyRecord).environmentId ?? (profile.target as AnyRecord).clusterEnvironmentId ?? null),
    };
  },

  // A NORMAL create: the credential is a REFERENCE, never a value.
  async createNormal(input: AnyRecord = {}) {
    const created = await client.create(sshDraft(input) as never);
    renderProfile(created as unknown as AnyRecord);
    return {
      created,
      profileId: created.profileId,
      credentialRef: created.credentialRef,
      environmentId: (created.target as AnyRecord).environmentId ?? (created.target as AnyRecord).clusterEnvironmentId ?? null,
      targetKind: (created.target as AnyRecord).kind,
      transportKind: (created.transport as AnyRecord).kind,
    };
  },

  // The client's own strict parser runs FIRST, so a secret-bearing draft never reaches the wire.
  async attemptSecretViaClient() {
    try {
      await client.create(sshDraft({ password: config.secret }) as never);
      return { rejected: false, code: null, message: null };
    } catch (error) {
      const typed = error as AnyRecord;
      return { rejected: true, code: typed?.code ?? null, message: String(typed?.message ?? error) };
    }
  },

  // A raw HTTP attempt that DOES reach the server, so the server-side secret guard is exercised.
  async attemptSecretViaHttp() {
    const body = JSON.stringify(sshDraft({ password: config.secret }));
    const response = await fetch(`${config.baseUrl}/api/v1/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body,
    });
    const text = await response.text();
    return { status: response.status, responseText: text, secretInResponse: occurrences(text, config.secret), requestHasSecret: occurrences(body, config.secret) };
  },

  capabilityEntry(input: AnyRecord) {
    return resolveRuntimeCapabilityEntry({
      client: input.client,
      transports: input.transports,
      managedTransport: input.managedTransport === true,
      environmentId: input.environmentId ?? null,
    }).map((row) => ({ capability: row.capability, state: row.state, reason: row.reason }));
  },

  directOnly(managed: boolean) {
    return isDirectOnlyRuntime({ managedTransport: managed });
  },
};

(window as unknown as AnyRecord).task25 = api;
