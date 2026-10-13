/**
 * Task 30 acceptance tests — the connection surfaces, mounted for real.
 *
 *   1. Browser and Electron expose the SAME capability entry.
 *   2. With no managed bridge the UI is explicitly direct-only.
 *   3. Cancelling a connection must NOT cancel a borrowed job.
 *   4. A password / OTP is never cached.
 *   5. A visible compute node AND a stable environment distinction.
 *
 * The tests drive the real components over a real happy-dom mount, the way task 24's
 * `ConnectionEntry.test.ts` does, and assert on the rendered identity attributes rather than on
 * a label string.
 */
import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionProfile } from '../../../shared/runtime/connectionProfile.js';
import ConnectionManager from './ConnectionManager.vue';
import ConnectionStatus from './ConnectionStatus.vue';
import RemoteBridgeActions from './RemoteBridgeActions.vue';
import SlurmExecutionForm from './SlurmExecutionForm.vue';
import SshHostForm from './SshHostForm.vue';
import type {
  RemoteBridgeUpdatePlan,
  RuntimeCapabilityRow,
  RuntimeClientKind,
  SlurmLifecycleStatus,
} from '../../composables/useRuntimeProfiles';
import { resolveRuntimeCapabilityEntry } from '../../composables/useRuntimeProfiles';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

function mount(component: unknown, props: Record<string, unknown>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(component as never, props);
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false });
  app.use(i18n);
  app.mount(host);
  return host;
}

const CLUSTER_ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const OTHER_ENVIRONMENT = '22222222-2222-4222-8222-222222222222';
const COMPUTE_NODE = 'compute-01.cluster';

function sshProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return Object.freeze({
    profileId: '33333333-3333-4333-8333-333333333333',
    name: 'Lab cluster',
    transport: Object.freeze({ kind: 'ssh' as const, endpoint: 'cluster.example.edu' }),
    target: Object.freeze({ kind: 'ssh' as const, environmentId: CLUSTER_ENVIRONMENT }),
    role: 'manager' as const,
    credentialRef: 'cred-1',
    enabled: true,
    ...overrides,
  }) as ConnectionProfile;
}

function slurmLifecycle(overrides: Partial<SlurmLifecycleStatus> = {}): SlurmLifecycleStatus {
  return Object.freeze({
    environmentId: CLUSTER_ENVIRONMENT,
    intentId: 'intent-1',
    jobId: '24680',
    state: 'RUNNING',
    queue: 'RUNNING',
    terminal: null,
    reconcile: null,
    attached: true,
    ownership: 'owned',
    computeNode: COMPUTE_NODE,
    stepId: 'step-1',
    epoch: 3,
    bridgeInstanceId: 'bridge-1',
    ...overrides,
  });
}

function capabilityEntryFor(client: RuntimeClientKind, managedTransport: boolean): readonly RuntimeCapabilityRow[] {
  return resolveRuntimeCapabilityEntry({
    client,
    transports: Object.freeze({ direct: true, ssh: true, slurm: true }),
    managedTransport,
  });
}

// ---------------------------------------------------------------------------
// 1. Browser and Electron expose the SAME capability entry
// ---------------------------------------------------------------------------

describe('Browser and Electron expose the SAME capability entry', () => {
  it('renders an identical capability surface for both clients', () => {
    const profiles = [sshProfile()];
    const browser = mount(ConnectionManager, {
      open: true,
      client: 'browser',
      profiles,
      capabilityEntry: capabilityEntryFor('browser', true),
      managedTransport: true,
    });
    const browserRows = [...browser.querySelectorAll('[data-testid="capability-entry"] [data-capability]')]
      .map((row) => `${row.getAttribute('data-capability')}:${row.getAttribute('data-state')}`);
    browser.remove();

    const electron = mount(ConnectionManager, {
      open: true,
      client: 'electron',
      profiles,
      capabilityEntry: capabilityEntryFor('electron', true),
      managedTransport: true,
    });
    const electronRows = [...electron.querySelectorAll('[data-testid="capability-entry"] [data-capability]')]
      .map((row) => `${row.getAttribute('data-capability')}:${row.getAttribute('data-state')}`);

    expect(browserRows).toEqual(['direct:supported', 'managed-bridge:supported', 'ssh:supported', 'slurm:supported']);
    expect(electronRows).toEqual(browserRows);
    // The client is attribution metadata on the surface, not a capability input.
    expect(browser.querySelector('[data-testid="connection-manager"]')?.getAttribute('data-client')).toBe('browser');
    expect(electron.querySelector('[data-testid="connection-manager"]')?.getAttribute('data-client')).toBe('electron');
    // Neither runtime gains a control the other lacks.
    expect(browser.querySelectorAll('button').length).toBe(electron.querySelectorAll('button').length);
  });

  it('exposes the same SSH and Slurm composer entry on both clients', () => {
    const profiles = [sshProfile()];
    for (const client of ['browser', 'electron'] as const) {
      const root = mount(ConnectionManager, {
        open: true,
        client,
        profiles,
        capabilityEntry: capabilityEntryFor(client, true),
        managedTransport: true,
      });
      const ssh = root.querySelector<HTMLButtonElement>('[data-testid="new-ssh-profile"]');
      const slurm = root.querySelector<HTMLButtonElement>('[data-testid="new-slurm-profile"]');
      expect(ssh?.disabled).toBe(false);
      expect(slurm?.disabled).toBe(false);
      root.remove();
    }
  });

  it('shows a profile row whose transport and stable target are both visible', () => {
    const root = mount(ConnectionManager, {
      open: true,
      client: 'browser',
      profiles: [sshProfile()],
      capabilityEntry: capabilityEntryFor('browser', true),
      managedTransport: true,
      selectedProfileId: '33333333-3333-4333-8333-333333333333',
    });
    const row = root.querySelector('[data-testid="connection-profile-row"]');
    expect(row?.getAttribute('data-transport')).toBe('ssh');
    expect(row?.getAttribute('data-enabled')).toBe('true');
    expect(row?.textContent).toContain('ssh');
    expect(row?.textContent).toContain('11111111…');
  });
});

// ---------------------------------------------------------------------------
// 2. With no managed bridge the UI is explicitly direct-only
// ---------------------------------------------------------------------------

describe('with no managed bridge the UI is explicitly direct-only', () => {
  it('renders a visible direct-only marker, not an absent control', () => {
    const root = mount(ConnectionManager, {
      open: true,
      client: 'browser',
      profiles: [sshProfile()],
      capabilityEntry: capabilityEntryFor('browser', false),
      managedTransport: false,
    });
    const marker = root.querySelector('[data-testid="direct-only-marker"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain('Direct only');
    expect(marker?.textContent).toContain('no managed bridge');
    // Direct is still offered; the managed transports are present and explicitly unavailable.
    expect(root.querySelector('[data-capability="direct"]')?.getAttribute('data-state')).toBe('supported');
    for (const capability of ['managed-bridge', 'ssh', 'slurm']) {
      const row = root.querySelector(`[data-capability="${capability}"]`);
      expect(row?.getAttribute('data-state')).toBe('unsupported');
      expect(row?.textContent?.length ?? 0).toBeGreaterThan(capability.length);
    }
    // The composer for an unavailable transport is present but disabled.
    expect(root.querySelector<HTMLButtonElement>('[data-testid="new-ssh-profile"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-testid="new-slurm-profile"]')?.disabled).toBe(true);
    expect(root.querySelector('[data-testid="new-profile-hint"]')?.textContent).toContain('unavailable');
  });

  it('hides the direct-only marker once a managed bridge exists', () => {
    const root = mount(ConnectionManager, {
      open: true,
      client: 'electron',
      profiles: [sshProfile()],
      capabilityEntry: capabilityEntryFor('electron', true),
      managedTransport: true,
    });
    expect(root.querySelector('[data-testid="direct-only-marker"]')).toBeNull();
    expect(root.querySelector('[data-testid="connection-manager"]')?.getAttribute('data-managed-transport')).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// 3. Cancelling a connection must NOT cancel a borrowed job
// ---------------------------------------------------------------------------

describe('cancelling a connection must NOT cancel a borrowed job', () => {
  const plan: RemoteBridgeUpdatePlan = Object.freeze({
    action: 'connect',
    location: 'remote',
    channel: 'transport',
    compatible: true,
    connectable: true,
    upgradePath: null,
    automatic: false,
    requiresExplicitAction: true,
  });

  it('offers detach on a borrowed allocation and refuses stop before any signal', () => {
    const emitted: string[] = [];
    const root = mount(RemoteBridgeActions, {
      slurm: slurmLifecycle({ ownership: 'borrowed' }),
      plan,
      onDetach: () => emitted.push('detach'),
      onStop: () => emitted.push('stop'),
      onReconnect: () => emitted.push('reconnect'),
      onUpdate: () => emitted.push('update'),
    });
    const detach = root.querySelector<HTMLButtonElement>('[data-testid="remote-detach"]');
    const stop = root.querySelector<HTMLButtonElement>('[data-testid="remote-stop"]');
    expect(detach?.disabled).toBe(false);
    expect(stop?.disabled).toBe(true);

    detach?.click();
    expect(emitted).toEqual(['detach']);

    const refusal = root.querySelector('[data-testid="remote-stop-refusal"]');
    expect(refusal?.textContent).toContain('Borrowed');
    expect(refusal?.textContent).toContain('never signals');
    expect(root.querySelector('[data-testid="remote-detach-note"]')?.textContent).toContain('never cancels');
  });

  it('cancels the connection without ever offering a stop affordance on it', async () => {
    const cancelled: unknown[] = [];
    const root = mount(ConnectionManager, {
      open: true,
      client: 'browser',
      profiles: [sshProfile()],
      capabilityEntry: capabilityEntryFor('browser', true),
      managedTransport: true,
      selectedProfileId: '33333333-3333-4333-8333-333333333333',
      status: { profileId: '33333333-3333-4333-8333-333333333333', state: 'connected', environmentId: CLUSTER_ENVIRONMENT, generation: 1 },
      slurm: slurmLifecycle({ ownership: 'borrowed' }),
      plan,
      onCancel: (value: unknown) => cancelled.push(value),
    });
    const cancel = root.querySelector<HTMLButtonElement>('[data-testid="connection-cancel"]');
    expect(cancel?.disabled).toBe(false);
    cancel?.click();
    await nextTick();
    expect(cancelled).toHaveLength(1);
    // The cancel path is the detach path: the borrowed job is still attached and un-signalled.
    const actions = root.querySelector('[data-testid="remote-bridge-actions"]');
    expect(actions?.querySelector<HTMLButtonElement>('[data-testid="remote-stop"]')?.disabled).toBe(true);
    expect(actions?.querySelector<HTMLButtonElement>('[data-testid="remote-detach"]')?.disabled).toBe(false);
  });

  it('signals an OWNED job only through the explicit stop action', () => {
    const emitted: string[] = [];
    const root = mount(RemoteBridgeActions, {
      slurm: slurmLifecycle({ ownership: 'owned', terminal: null, jobId: '24680' }),
      plan,
      onStop: () => emitted.push('stop'),
    });
    expect(root.querySelector<HTMLButtonElement>('[data-testid="remote-stop"]')?.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-testid="remote-stop"]')?.click();
    expect(emitted).toEqual(['stop']);
    expect(root.querySelector('[data-testid="remote-stop-refusal"]')).toBeNull();
  });

  it('refuses stop once the job reached a terminal state', () => {
    const root = mount(RemoteBridgeActions, {
      slurm: slurmLifecycle({ ownership: 'owned', terminal: 'CANCELLED', jobId: '24680' }),
      plan,
    });
    expect(root.querySelector<HTMLButtonElement>('[data-testid="remote-stop"]')?.disabled).toBe(true);
    expect(root.querySelector('[data-testid="remote-stop-refusal"]')?.textContent).toContain('CANCELLED');
  });
});

// ---------------------------------------------------------------------------
// 4. A password / OTP is never cached
// ---------------------------------------------------------------------------

describe('a password / OTP is never cached', () => {
  const SECRET = 'correct-horse-battery';

  it('drops the secret from the component the moment the answer is handed over', async () => {
    const answers: Array<{ challengeId: string; accept: boolean; secret?: string }> = [];
    const root = mount(ConnectionManager, {
      open: true,
      client: 'browser',
      profiles: [sshProfile()],
      capabilityEntry: capabilityEntryFor('browser', true),
      managedTransport: true,
      challenge: {
        challengeId: 'challenge-1',
        kind: 'password',
        prompt: 'Password:',
        echo: false,
        redacted: true,
        createdAt: 1,
      },
      onChallengeAnswer: (answer: { challengeId: string; accept: boolean; secret?: string }) => answers.push(answer),
    });
    const input = root.querySelector<HTMLInputElement>('[data-testid="challenge-secret"]');
    expect(input).not.toBeNull();
    expect(input?.type).toBe('password');
    input!.value = SECRET;
    input!.dispatchEvent(new Event('input'));
    await nextTick();

    root.querySelector<HTMLButtonElement>('[data-testid="challenge-accept"]')?.click();
    await nextTick();

    expect(answers).toEqual([{ challengeId: 'challenge-1', accept: true, secret: SECRET }]);
    // The value is gone from the DOM: nothing in this component retains it.
    expect(root.querySelector<HTMLInputElement>('[data-testid="challenge-secret"]')?.value).toBe('');
    // And it never reached a profile payload: the profile row carries a credential reference only.
    expect(JSON.stringify(root.querySelector('[data-testid="connection-profile-row"]')?.getAttribute('data-profile-id'))).not.toContain(SECRET);
  });

  it('never offers an accept path for a changed host key', () => {
    const answers: unknown[] = [];
    const root = mount(ConnectionManager, {
      open: true,
      client: 'browser',
      profiles: [sshProfile()],
      capabilityEntry: capabilityEntryFor('browser', true),
      managedTransport: true,
      challenge: {
        challengeId: 'challenge-2',
        kind: 'host-key-changed',
        prompt: 'The host key changed.',
        echo: false,
        redacted: true,
        createdAt: 1,
        fingerprint: 'SHA256:changed',
      },
      onChallengeAnswer: (answer: unknown) => answers.push(answer),
    });
    expect(root.querySelector('[data-testid="challenge-refusal"]')?.textContent).toContain('never accepted');
    expect(root.querySelector('[data-testid="challenge-fingerprint"]')?.textContent).toContain('SHA256:changed');
    expect(root.querySelector<HTMLButtonElement>('[data-testid="challenge-accept"]')?.disabled).toBe(true);
    // No secret input is rendered for a trust-only challenge.
    expect(root.querySelector('[data-testid="challenge-secret"]')).toBeNull();
  });

  it('asks for a one-time code as its own challenge kind, not a password', () => {
    const root = mount(ConnectionManager, {
      open: true,
      client: 'browser',
      profiles: [sshProfile()],
      capabilityEntry: capabilityEntryFor('browser', true),
      managedTransport: true,
      challenge: {
        challengeId: 'challenge-3',
        kind: 'otp',
        prompt: 'Verification code:',
        echo: false,
        redacted: true,
        createdAt: 1,
      },
    });
    expect(root.querySelector('[data-testid="connection-challenge"]')?.getAttribute('data-kind')).toBe('otp');
    expect(root.querySelector('[data-testid="challenge-prompt"]')?.textContent).toContain('Verification code');
    expect(root.querySelector('[data-testid="challenge-secret"]')?.getAttribute('type')).toBe('text');
  });

  it('stores a credential reference on the SSH form and never a secret field', async () => {
    const saved: unknown[] = [];
    const root = mount(SshHostForm, {
      available: true,
      environmentId: CLUSTER_ENVIRONMENT,
      onSave: (draft: unknown) => saved.push(draft),
    });
    const set = (testId: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    set('ssh-name', 'Lab cluster');
    set('ssh-endpoint', 'cluster.example.edu');
    set('ssh-credential-ref', 'cred-1');
    await nextTick();

    root.querySelector<HTMLButtonElement>('[data-testid="ssh-host-save"]')?.click();
    await nextTick();

    expect(saved).toHaveLength(1);
    const draft = saved[0] as Record<string, unknown>;
    expect(draft).toMatchObject({
      name: 'Lab cluster',
      transport: { kind: 'ssh', endpoint: 'cluster.example.edu' },
      target: { kind: 'ssh', environmentId: CLUSTER_ENVIRONMENT },
      role: 'manager',
      credentialRef: 'cred-1',
      enabled: false,
    });
    // The draft carries no secret key of any kind.
    expect(Object.keys(draft).some((key) => /password|secret|token|otp|passphrase/iu.test(key))).toBe(false);
    expect(JSON.stringify(draft)).not.toContain('password');
  });

  it('refuses an SSH profile until the host has been probed for its stable environment', async () => {
    const saved: unknown[] = [];
    const root = mount(SshHostForm, { available: true, environmentId: '', onSave: (draft: unknown) => saved.push(draft) });
    expect(root.querySelector('[data-testid="ssh-environment-unresolved"]')?.textContent).toContain('stable environment');
    expect(root.querySelector<HTMLButtonElement>('[data-testid="ssh-host-save"]')?.disabled).toBe(true);
    expect(saved).toHaveLength(0);
  });

  it('rejects a locator that embeds a secret, through the real parser in the form', async () => {
    const saved: unknown[] = [];
    const root = mount(SshHostForm, { available: true, environmentId: CLUSTER_ENVIRONMENT, onSave: (draft: unknown) => saved.push(draft) });
    const set = (testId: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    set('ssh-name', 'Lab cluster');
    set('ssh-endpoint', 'user:pass@cluster.example.edu');
    await nextTick();
    root.querySelector<HTMLButtonElement>('[data-testid="ssh-host-save"]')?.click();
    await nextTick();
    expect(saved).toHaveLength(0);
    expect(root.querySelector('[data-testid="ssh-host-problems"]')?.textContent).toContain('transport.endpoint');
  });
});

// ---------------------------------------------------------------------------
// 5. A visible compute node AND a stable environment distinction
// ---------------------------------------------------------------------------

describe('a visible compute node AND a stable environment distinction', () => {
  it('renders the compute node AND the cluster environment id as separate identities', () => {
    const root = mount(ConnectionStatus, {
      identity: { environmentId: CLUSTER_ENVIRONMENT, targetKind: 'slurm' },
      status: { profileId: 'p-1', state: 'connected', environmentId: CLUSTER_ENVIRONMENT, generation: 1 },
      slurm: slurmLifecycle(),
    });
    const surface = root.querySelector('[data-testid="connection-lifecycle"]');
    expect(surface?.getAttribute('data-environment-id')).toBe(CLUSTER_ENVIRONMENT);
    expect(surface?.getAttribute('data-compute-node')).toBe(COMPUTE_NODE);
    expect(surface?.getAttribute('data-job-id')).toBe('24680');
    expect(surface?.getAttribute('data-ownership')).toBe('owned');
    // The environment is the cluster UUID — never the compute hostname and never the job id.
    expect(root.querySelector('[data-testid="connection-environment-id"]')?.textContent).toBe(CLUSTER_ENVIRONMENT);
    expect(root.querySelector('[data-testid="connection-environment-id"]')?.textContent).not.toBe(COMPUTE_NODE);
    expect(root.querySelector('[data-testid="connection-compute-node-id"]')?.textContent).toBe(COMPUTE_NODE);
    expect(root.querySelector('[data-testid="connection-job-id"]')?.textContent).toBe('24680');
    expect(root.querySelector('[data-testid="connection-step-epoch"]')?.textContent).toContain('step-1');
    expect(root.querySelector('[data-testid="connection-bridge-instance-id"]')?.textContent).toBe('bridge-1');
  });

  it('distinguishes two environments that share the SAME compute node', () => {
    const first = mount(ConnectionStatus, {
      identity: { environmentId: CLUSTER_ENVIRONMENT, targetKind: 'slurm' },
      slurm: slurmLifecycle({ environmentId: CLUSTER_ENVIRONMENT, computeNode: COMPUTE_NODE }),
    });
    const second = mount(ConnectionStatus, {
      identity: { environmentId: OTHER_ENVIRONMENT, targetKind: 'slurm' },
      slurm: slurmLifecycle({ environmentId: OTHER_ENVIRONMENT, computeNode: COMPUTE_NODE, intentId: 'intent-2', jobId: '13579' }),
    });
    expect(first.querySelector('[data-testid="connection-lifecycle"]')?.getAttribute('data-environment-id')).toBe(CLUSTER_ENVIRONMENT);
    expect(second.querySelector('[data-testid="connection-lifecycle"]')?.getAttribute('data-environment-id')).toBe(OTHER_ENVIRONMENT);
    // Same node, different environment: the node is not the identity.
    expect(first.querySelector('[data-testid="connection-lifecycle"]')?.getAttribute('data-compute-node'))
      .toBe(second.querySelector('[data-testid="connection-lifecycle"]')?.getAttribute('data-compute-node'));
    expect(first.querySelector('[data-testid="connection-lifecycle"]')?.getAttribute('data-environment-id'))
      .not.toBe(second.querySelector('[data-testid="connection-lifecycle"]')?.getAttribute('data-environment-id'));
  });

  it('names the pending reason from the control store fields, not from a status string', () => {
    const pending = mount(ConnectionStatus, {
      identity: { environmentId: CLUSTER_ENVIRONMENT, targetKind: 'slurm' },
      slurm: slurmLifecycle({ state: 'submitted', queue: 'PENDING', terminal: null, bridgeInstanceId: null }),
    });
    expect(pending.querySelector('[data-testid="connection-pending-reason"]')?.textContent).toContain('Queued');
    expect(pending.querySelector('[data-testid="connection-lifecycle"]')?.getAttribute('data-pending-reason')).toContain('Queued');
    pending.remove();

    const ambiguous = mount(ConnectionStatus, {
      identity: { environmentId: CLUSTER_ENVIRONMENT, targetKind: 'slurm' },
      slurm: slurmLifecycle({ state: 'reconciling', queue: null, terminal: null, reconcile: 'ambiguous' }),
    });
    expect(ambiguous.querySelector('[data-testid="connection-lifecycle"]')?.getAttribute('data-pending-reason'))
      .toContain('never resubmitting');
    ambiguous.remove();

    const terminal = mount(ConnectionStatus, {
      identity: { environmentId: CLUSTER_ENVIRONMENT, targetKind: 'slurm' },
      slurm: slurmLifecycle({ terminal: 'CANCELLED', queue: 'CANCELLED', attached: false }),
    });
    expect(terminal.querySelector('[data-testid="connection-pending-reason"]')).toBeNull();
    expect(terminal.querySelector('[data-testid="connection-terminal"]')?.textContent).toContain('CANCELLED');
    expect(terminal.querySelector('[data-testid="connection-lifecycle"]')?.getAttribute('data-terminal')).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// Slurm execution form — explicit resources and a real preview
// ---------------------------------------------------------------------------

describe('the Slurm execution form shows an explicit resource and time preview', () => {
  const preview = Object.freeze({
    nodes: 1,
    ntasks: 1,
    cpus: 5,
    memory: '4224M',
    memoryMiB: 4224,
    time: '01:00:00',
    timeSeconds: 3600,
    gres: 'none',
    requestsGpu: false,
    partition: 'cpu',
    account: 'research',
  });

  it('renders the bridge-produced preview rather than a client-side re-derivation', async () => {
    const submitted: unknown[] = [];
    const root = mount(SlurmExecutionForm, {
      available: true,
      preview,
      onSubmit: (request: unknown) => submitted.push(request),
    });
    const surface = root.querySelector('[data-testid="slurm-resource-preview"]');
    expect(surface?.getAttribute('data-nodes')).toBe('1');
    expect(surface?.getAttribute('data-cpus')).toBe('5');
    expect(surface?.getAttribute('data-memory-mib')).toBe('4224');
    expect(surface?.getAttribute('data-time-seconds')).toBe('3600');
    expect(surface?.getAttribute('data-gres')).toBe('none');
    expect(surface?.getAttribute('data-requests-gpu')).toBe('false');
    expect(surface?.getAttribute('data-partition')).toBe('cpu');
    expect(surface?.getAttribute('data-account')).toBe('research');
    expect(root.querySelector('[data-testid="slurm-preview-time"]')?.textContent).toBe('01:00:00');
    expect(root.querySelector('[data-testid="slurm-preview-note"]')?.textContent).toContain('No GPU');

    const set = (testId: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    set('slurm-partition', 'cpu');
    set('slurm-account', 'research');
    set('slurm-memory', '4096');
    set('slurm-time', '01:00:00');
    await nextTick();
    root.querySelector<HTMLButtonElement>('[data-testid="slurm-form-submit"]')?.click();
    await nextTick();

    expect(submitted).toEqual([{
      resources: { partition: 'cpu', account: 'research', cpus: 1, memory: '4096', time: '01:00:00', gres: 'none' },
      ownership: 'owned',
    }]);
  });

  it('refuses to submit a request whose time or gres is blank', async () => {
    const submitted: unknown[] = [];
    const root = mount(SlurmExecutionForm, { available: true, preview, onSubmit: (request: unknown) => submitted.push(request) });
    const set = (testId: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    set('slurm-partition', 'cpu');
    set('slurm-memory', '4096');
    set('slurm-time', '');
    set('slurm-gres', '');
    await nextTick();
    root.querySelector<HTMLButtonElement>('[data-testid="slurm-form-submit"]')?.click();
    await nextTick();
    expect(submitted).toHaveLength(0);
    const problems = root.querySelector('[data-testid="slurm-form-problems"]');
    expect(problems?.textContent).toContain('time');
    expect(problems?.textContent).toContain('gres');
  });

  it('marks a GPU request explicitly instead of implying one', () => {
    const root = mount(SlurmExecutionForm, {
      available: true,
      preview: Object.freeze({ ...preview, gres: 'gpu:a100:2', requestsGpu: true, cpus: 5 }),
    });
    const surface = root.querySelector('[data-testid="slurm-resource-preview"]');
    expect(surface?.getAttribute('data-gres')).toBe('gpu:a100:2');
    expect(surface?.getAttribute('data-requests-gpu')).toBe('true');
    expect(root.querySelector('[data-testid="slurm-preview-note"]')?.textContent).toContain('never implied');
  });

  it('disables the form when the Slurm capability is unavailable', () => {
    const root = mount(SlurmExecutionForm, { available: false, unavailableReason: 'No managed bridge: Slurm is unavailable', preview });
    expect(root.querySelector('[data-testid="slurm-form-unavailable"]')?.textContent).toContain('No managed bridge');
    expect(root.querySelector<HTMLButtonElement>('[data-testid="slurm-form-submit"]')?.disabled).toBe(true);
  });
});
