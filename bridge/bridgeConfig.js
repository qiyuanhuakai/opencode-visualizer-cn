import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const CONFIG_VERSION = 1;

const ACP_PRESETS = [
  { id: 'pi', name: 'Pi', command: 'pi-acp', args: [], enabled: false },
  { id: 'oh-my-pi', name: 'Oh My Pi', command: 'omp', args: ['--mode', 'acp'], enabled: false },
  { id: 'kimi-code', name: 'Kimi Code', command: 'kimi', args: ['acp'], enabled: false },
];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`ACP agent ${field} must not be empty.`);
  }
  return value.trim();
}

function parseAgent(input) {
  if (!isRecord(input)) throw new Error('ACP agent must be an object.');
  const id = parseRequiredString(input.id, 'id');
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    throw new Error('ACP agent id must use lowercase letters, numbers, dots, underscores, or hyphens.');
  }
  const args = input.args ?? [];
  if (!Array.isArray(args) || !args.every((item) => typeof item === 'string')) {
    throw new Error('ACP agent args must be an array of strings.');
  }
  if (typeof input.enabled !== 'boolean') {
    throw new Error('ACP agent enabled must be a boolean.');
  }
  const env = input.env;
  if (env !== undefined && (!isRecord(env) || !Object.values(env).every((value) => typeof value === 'string'))) {
    throw new Error('ACP agent env must contain only string values.');
  }
  return {
    id,
    name: parseRequiredString(input.name, 'name'),
    command: parseRequiredString(input.command, 'command'),
    args: [...args],
    enabled: input.enabled,
    ...(env === undefined ? {} : { env: { ...env } }),
  };
}

export function createDefaultBridgeConfig() {
  return {
    version: CONFIG_VERSION,
    acpAgents: ACP_PRESETS.map((agent) => ({ ...agent, args: [...agent.args] })),
  };
}

export function parseBridgeConfig(input) {
  if (!isRecord(input)) throw new Error('Bridge config must be an object.');
  if (input.version !== CONFIG_VERSION) throw new Error(`Unsupported bridge config version: ${String(input.version)}.`);
  if (!Array.isArray(input.acpAgents)) throw new Error('Bridge config acpAgents must be an array.');
  const acpAgents = input.acpAgents.map(parseAgent);
  const ids = new Set();
  for (const agent of acpAgents) {
    if (ids.has(agent.id)) throw new Error(`Duplicate ACP agent id: ${agent.id}.`);
    ids.add(agent.id);
  }
  return { version: CONFIG_VERSION, acpAgents };
}

export function defaultBridgeConfigPath(env = process.env) {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config');
  return path.join(configRoot, 'vis', 'bridge.json');
}

export function createBridgeConfigStore(options = {}) {
  const configPath = options.configPath ?? defaultBridgeConfigPath();
  let current;

  async function save(config) {
    const parsed = parseBridgeConfig(config);
    const directory = path.dirname(configPath);
    const temporaryPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, configPath);
    current = parsed;
    return parsed;
  }

  async function load() {
    try {
      current = parseBridgeConfig(JSON.parse(await readFile(configPath, 'utf8')));
      return current;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return save(createDefaultBridgeConfig());
      }
      throw error;
    }
  }

  async function getConfig() {
    return current ?? load();
  }

  async function upsertAgent(input) {
    const agent = parseAgent(input);
    const config = await getConfig();
    const index = config.acpAgents.findIndex((item) => item.id === agent.id);
    const agents = config.acpAgents.map((item) => ({ ...item, args: [...item.args] }));
    if (index === -1) agents.push(agent);
    else agents[index] = agent;
    return save({ ...config, acpAgents: agents });
  }

  async function removeAgent(id) {
    const config = await getConfig();
    return save({ ...config, acpAgents: config.acpAgents.filter((agent) => agent.id !== id) });
  }

  return { configPath, load, save, getConfig, upsertAgent, removeAgent };
}
