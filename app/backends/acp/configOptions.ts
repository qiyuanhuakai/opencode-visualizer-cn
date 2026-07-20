import { toRecord } from './wire';

export type AcpSelectOption = {
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  options: Array<{ value: string; name: string; description?: string }>;
};

export function parseAcpSelectOptions(values: unknown[]): AcpSelectOption[] {
  return values.flatMap((value) => {
    const record = toRecord(value);
    if (
      !record ||
      record.type !== 'select' ||
      typeof record.id !== 'string' ||
      typeof record.name !== 'string' ||
      typeof record.currentValue !== 'string' ||
      !Array.isArray(record.options)
    )
      return [];
    const options = record.options.flatMap((item) => {
      const option = toRecord(item);
      if (!option || typeof option.value !== 'string' || typeof option.name !== 'string') return [];
      return [
        {
          value: option.value,
          name: option.name,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
        },
      ];
    });
    return [
      {
        id: record.id,
        name: record.name,
        ...(typeof record.category === 'string' ? { category: record.category } : {}),
        currentValue: record.currentValue,
        options,
      },
    ];
  });
}

export function createAcpProviderResponse(values: unknown[], label: string) {
  const model = parseAcpSelectOptions(values).find(
    (option) => option.category === 'model' || option.id === 'model',
  );
  const options = model?.options.length
    ? model.options
    : [{ value: 'default', name: 'Agent default' }];
  return {
    all: [
      {
        id: 'acp',
        name: label,
        models: Object.fromEntries(
          options.map((option) => [
            option.value,
            {
              id: option.value,
              name: option.name,
              providerID: 'acp',
              capabilities: { attachment: true, reasoning: true, toolcall: true },
            },
          ]),
        ),
      },
    ],
    default: { acp: model?.currentValue ?? 'default' },
    connected: ['acp'],
  };
}

const ACP_PERMISSION_MODE_VALUES = new Set(['normal', 'acceptEdits', 'bypassPermissions']);

function isAcpPermissionMode(value: string) {
  return ACP_PERMISSION_MODE_VALUES.has(value);
}

function toAcpAgentModeId(value: string) {
  return value === 'normal' || value === 'default' ? 'default' : value;
}

function isAcpAgentMode(value: string) {
  return value === 'normal' || value === 'default' || !isAcpPermissionMode(value);
}

export function createAcpAgentSelectorOptions(values: unknown[], fallbackLabel: string) {
  const mode = parseAcpSelectOptions(values).find(
    (option) => option.category === 'mode' || option.id === 'mode',
  );
  const agents = new Map<string, { id: string; label: string; description?: string }>();
  for (const option of mode?.options ?? []) {
    if (!isAcpAgentMode(option.value)) continue;
    const id = toAcpAgentModeId(option.value);
    agents.set(id, { id, label: option.name, description: option.description });
  }
  return agents.size > 0
    ? [...agents.values()]
    : [{ id: 'default', label: 'Default', description: fallbackLabel }];
}

export function createAcpAgentList(values: unknown[], label: string) {
  return createAcpAgentSelectorOptions(values, label).map((option) => ({
    name: option.id,
    description: option.description ?? option.label,
    mode: 'primary',
  }));
}

export function createAcpPermissionModeList(values: unknown[]) {
  const mode = parseAcpSelectOptions(values).find(
    (option) => option.category === 'mode' || option.id === 'mode',
  );
  const options = (mode?.options ?? [])
    .filter((option) => isAcpPermissionMode(option.value))
    .map((option) => ({ id: option.value, name: option.name }));
  const current = options.some((option) => option.id === mode?.currentValue)
    ? (mode?.currentValue ?? 'normal')
    : (options[0]?.id ?? 'normal');
  return { current, options };
}

export function resolveAcpModeSelection(agent: string, permissionMode: string) {
  return agent === 'default' ? permissionMode : agent;
}

export function createAcpUiModeState(values: unknown[], previousPermissionMode: string) {
  const mode = parseAcpSelectOptions(values).find(
    (option) => option.category === 'mode' || option.id === 'mode',
  );
  const permission = createAcpPermissionModeList(values);
  const permissionMode = permission.options.some((option) => option.id === mode?.currentValue)
    ? (mode?.currentValue ?? permission.current)
    : permission.options.some((option) => option.id === previousPermissionMode)
      ? previousPermissionMode
      : permission.current;
  const agentOptions = createAcpAgentSelectorOptions(values, 'ACP');
  const currentAgent = mode?.currentValue && isAcpAgentMode(mode.currentValue)
    ? toAcpAgentModeId(mode.currentValue)
    : 'default';
  return {
    agent: agentOptions.some((option) => option.id === currentAgent) ? currentAgent : 'default',
    permissionMode,
  };
}

export async function syncAcpPromptConfig(
  sessionId: string,
  values: unknown[],
  selection: { model: string; mode: string; thoughtLevel?: string },
  request: (params: { sessionId: string; configId: string; value: string }) => Promise<unknown>,
) {
  const options = parseAcpSelectOptions(values);
  const desired = [
    { categories: ['model'], value: selection.model },
    { categories: ['mode'], value: selection.mode },
    { categories: ['thought_level', 'thinking'], value: selection.thoughtLevel },
  ];
  for (const target of desired) {
    if (!target.value) continue;
    const option = options.find(
      (candidate) =>
        target.categories.includes(candidate.category ?? '') ||
        target.categories.includes(candidate.id),
    );
    if (
      !option ||
      option.currentValue === target.value ||
      !option.options.some((candidate) => candidate.value === target.value)
    )
      continue;
    await request({ sessionId, configId: option.id, value: target.value });
    const source = values.find((value) => toRecord(value)?.id === option.id);
    const sourceRecord = toRecord(source);
    if (sourceRecord) sourceRecord.currentValue = target.value;
  }
}
