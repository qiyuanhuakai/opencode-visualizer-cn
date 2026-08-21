import { ref } from 'vue';
import { acpBridgeHttpUrl } from '../backends/acp/bridgeUrl';
import { getPersistedAcpBridgeToken, getPersistedAcpBridgeUrl } from '../backends/registry';

export type AcpAgentState = 'disabled' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type BridgeServiceState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'adopted'
  | 'stopping'
  | 'error';

export type BridgeServiceStatus = {
  id: string;
  name: string;
  command: string;
  args: string[];
  state: BridgeServiceState;
  owned: boolean;
  pid?: number;
  error?: string;
};

export type AcpAgentStatus = {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  state: AcpAgentState;
  owned: boolean;
  connected: boolean;
  droppedFrames: number;
  pid?: number;
  error?: string;
};

type AcpAgentInput = Pick<AcpAgentStatus, 'id' | 'name' | 'command' | 'args' | 'enabled'> & {
  env?: Record<string, string>;
};

export type FetchAcpBridgeAgentsOptions = {
  fetcher?: typeof fetch;
  bridgeUrl: string;
  bridgeToken?: string;
};

export async function fetchAcpBridgeAgents(options: FetchAcpBridgeAgentsOptions) {
  const fetcher = options.fetcher ?? fetch;
  const headers = new Headers();
  const token = options.bridgeToken?.trim();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetcher(acpBridgeHttpUrl(options.bridgeUrl, '/api/v1/supervisor'), {
    headers: Object.fromEntries(headers.entries()),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `Bridge request failed (${response.status}).`;
    throw new Error(message);
  }
  if (!isRecord(body) || !Array.isArray(body.acpAgents)) {
    throw new Error('Invalid bridge supervisor response.');
  }
  return body.acpAgents.map(parseAgent);
}

type UseAcpBridgeOptions = {
  fetcher?: typeof fetch;
  bridgeUrl?: string;
  bridgeToken?: string;
};

const AGENT_STATES = new Set<AcpAgentState>([
  'disabled',
  'stopped',
  'starting',
  'running',
  'stopping',
  'error',
]);
const SERVICE_STATES = new Set<BridgeServiceState>([
  'stopped',
  'starting',
  'running',
  'adopted',
  'stopping',
  'error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ACP agent ${field}.`);
  return value;
}

function parseAgent(value: unknown): AcpAgentStatus {
  if (!isRecord(value)) throw new Error('Invalid ACP agent response.');
  if (!Array.isArray(value.args) || !value.args.every((item) => typeof item === 'string')) {
    throw new Error('Invalid ACP agent args.');
  }
  if (typeof value.state !== 'string' || !AGENT_STATES.has(value.state as AcpAgentState)) {
    throw new Error('Invalid ACP agent state.');
  }
  if (
    typeof value.enabled !== 'boolean' ||
    typeof value.owned !== 'boolean' ||
    typeof value.connected !== 'boolean'
  ) {
    throw new Error('Invalid ACP agent flags.');
  }
  if (typeof value.droppedFrames !== 'number') throw new Error('Invalid ACP dropped frame count.');
  if (value.pid !== undefined && typeof value.pid !== 'number')
    throw new Error('Invalid ACP agent pid.');
  if (value.error !== undefined && typeof value.error !== 'string')
    throw new Error('Invalid ACP agent error.');
  return {
    id: requiredString(value.id, 'id'),
    name: requiredString(value.name, 'name'),
    command: requiredString(value.command, 'command'),
    args: [...value.args],
    enabled: value.enabled,
    state: value.state as AcpAgentState,
    owned: value.owned,
    connected: value.connected,
    droppedFrames: value.droppedFrames,
    ...(value.pid === undefined ? {} : { pid: value.pid }),
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

function parseService(value: unknown): BridgeServiceStatus {
  if (
    !isRecord(value) ||
    !Array.isArray(value.args) ||
    !value.args.every((item) => typeof item === 'string') ||
    typeof value.state !== 'string' ||
    !SERVICE_STATES.has(value.state as BridgeServiceState) ||
    typeof value.owned !== 'boolean'
  )
    throw new Error('Invalid bridge service response.');
  return {
    id: requiredString(value.id, 'service id'),
    name: requiredString(value.name, 'service name'),
    command: requiredString(value.command, 'service command'),
    args: [...value.args],
    state: value.state as BridgeServiceState,
    owned: value.owned,
    ...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useAcpBridge(options: UseAcpBridgeOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const bridgeUrl = options.bridgeUrl ?? getPersistedAcpBridgeUrl();
  const bridgeToken = options.bridgeToken ?? getPersistedAcpBridgeToken();
  const agents = ref<AcpAgentStatus[]>([]);
  const services = ref<BridgeServiceStatus[]>([]);
  const loading = ref(false);
  const bridgeAvailable = ref(false);
  const error = ref('');

  async function request(endpoint: `/${string}`, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (bridgeToken) headers.set('Authorization', `Bearer ${bridgeToken}`);
    const response = await fetcher(acpBridgeHttpUrl(bridgeUrl, endpoint), {
      ...init,
      headers: Object.fromEntries(headers.entries()),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const message =
        isRecord(body) && typeof body.error === 'string'
          ? body.error
          : `Bridge request failed (${response.status}).`;
      throw new Error(message);
    }
    return body;
  }

  async function refresh() {
    loading.value = true;
    try {
      const body = await request('/api/v1/supervisor');
      if (!isRecord(body) || !Array.isArray(body.services) || !Array.isArray(body.acpAgents)) {
        throw new Error('Invalid bridge supervisor response.');
      }
      services.value = body.services.map(parseService);
      agents.value = body.acpAgents.map(parseAgent);
      bridgeAvailable.value = true;
      error.value = '';
    } catch (cause) {
      agents.value = [];
      services.value = [];
      bridgeAvailable.value = false;
      error.value = errorMessage(cause);
    } finally {
      loading.value = false;
    }
  }

  async function updateAgent(id: string, patch: Partial<AcpAgentInput>) {
    const body = await request(`/api/v1/agents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const next = parseAgent(body);
    agents.value = agents.value.map((agent) => (agent.id === id ? next : agent));
    bridgeAvailable.value = true;
    error.value = '';
    return next;
  }

  async function createAgent(input: AcpAgentInput) {
    const body = await request('/api/v1/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const next = parseAgent(body);
    agents.value = [...agents.value.filter((agent) => agent.id !== next.id), next];
    return next;
  }

  async function removeAgent(id: string) {
    await request(`/api/v1/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    agents.value = agents.value.filter((agent) => agent.id !== id);
  }

  return {
    agents,
    services,
    loading,
    bridgeAvailable,
    error,
    refresh,
    updateAgent,
    createAgent,
    removeAgent,
  };
}
