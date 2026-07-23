export type AcpAgentInfo = {
  name: string;
  title?: string;
  version: string;
};

export type AcpAgentCapabilities = {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  sessionCapabilities?: Record<string, unknown>;
};

export type AcpInitializeResult = {
  protocolVersion: number;
  agentCapabilities: AcpAgentCapabilities;
  agentInfo?: AcpAgentInfo;
  authMethods: AcpAuthMethod[];
};

export type AcpAuthMethod = {
  id: string;
  name: string;
  description?: string;
  type?: string;
  args?: string[];
  initialInput?: string;
};

export type AcpSessionUpdateParams = {
  sessionId: string;
  update: Record<string, unknown> & { sessionUpdate: string };
};

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

export type AcpPermissionRequestParams = {
  sessionId: string;
  toolCall: Record<string, unknown> & { toolCallId: string };
  options: AcpPermissionOption[];
};

export function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalBoolean(record: Record<string, unknown>, key: string) {
  return typeof record[key] === 'boolean' ? record[key] : undefined;
}

export function parseInitializeResult(value: unknown): AcpInitializeResult {
  const record = toRecord(value);
  if (!record || typeof record.protocolVersion !== 'number') {
    throw new Error('ACP initialize response is invalid.');
  }
  const capabilitiesRecord = toRecord(record.agentCapabilities) ?? {};
  const promptRecord = toRecord(capabilitiesRecord.promptCapabilities);
  const sessionRecord = toRecord(capabilitiesRecord.sessionCapabilities);
  const agentRecord = toRecord(record.agentInfo);
  const agentInfo =
    agentRecord && typeof agentRecord.name === 'string' && typeof agentRecord.version === 'string'
      ? {
          name: agentRecord.name,
          ...(typeof agentRecord.title === 'string' ? { title: agentRecord.title } : {}),
          version: agentRecord.version,
        }
      : undefined;
  const authMethods = Array.isArray(record.authMethods)
    ? record.authMethods.flatMap((value): AcpAuthMethod[] => {
        const method = toRecord(value);
        if (!method || typeof method.id !== 'string' || typeof method.name !== 'string') return [];
        return [
          {
            id: method.id,
            name: method.name,
            ...(typeof method.description === 'string' ? { description: method.description } : {}),
            ...(typeof method.type === 'string' ? { type: method.type } : {}),
            ...(Array.isArray(method.args) && method.args.every((arg) => typeof arg === 'string')
              ? { args: method.args }
              : {}),
          },
        ];
      })
    : [];
  return {
    protocolVersion: record.protocolVersion,
    agentCapabilities: {
      loadSession: optionalBoolean(capabilitiesRecord, 'loadSession'),
      promptCapabilities: promptRecord
        ? {
            image: optionalBoolean(promptRecord, 'image'),
            audio: optionalBoolean(promptRecord, 'audio'),
            embeddedContext: optionalBoolean(promptRecord, 'embeddedContext'),
          }
        : undefined,
      sessionCapabilities: sessionRecord ?? undefined,
    },
    agentInfo,
    authMethods,
  };
}

export function parseNewSessionResult(value: unknown) {
  const record = toRecord(value);
  if (!record || typeof record.sessionId !== 'string' || !record.sessionId) {
    throw new Error('ACP session/new response is invalid.');
  }
  return {
    sessionId: record.sessionId,
    configOptions: Array.isArray(record.configOptions) ? record.configOptions : [],
  };
}

export function parseSessionConfigOptions(value: unknown) {
  const record = toRecord(value);
  return Array.isArray(record?.configOptions) ? record.configOptions : [];
}

export function parsePromptResult(value: unknown) {
  const record = toRecord(value);
  if (!record || typeof record.stopReason !== 'string') {
    throw new Error('ACP session/prompt response is invalid.');
  }
  const usage = toRecord(record.usage);
  return {
    stopReason: record.stopReason,
    usage:
      usage &&
      typeof usage.inputTokens === 'number' &&
      typeof usage.outputTokens === 'number' &&
      typeof usage.totalTokens === 'number'
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          }
        : undefined,
  };
}

export function parseSessionUpdateParams(value: unknown): AcpSessionUpdateParams | null {
  const record = toRecord(value);
  const update = toRecord(record?.update);
  if (
    !record ||
    typeof record.sessionId !== 'string' ||
    !update ||
    typeof update.sessionUpdate !== 'string'
  ) {
    return null;
  }
  return {
    sessionId: record.sessionId,
    update: { ...update, sessionUpdate: update.sessionUpdate },
  };
}

const permissionKinds = new Set<AcpPermissionOption['kind']>([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);

export function parsePermissionRequest(value: unknown): AcpPermissionRequestParams | null {
  const record = toRecord(value);
  const toolCall = toRecord(record?.toolCall);
  if (
    !record ||
    typeof record.sessionId !== 'string' ||
    !toolCall ||
    typeof toolCall.toolCallId !== 'string'
  ) {
    return null;
  }
  const options = Array.isArray(record.options)
    ? record.options.flatMap((item) => {
        const option = toRecord(item);
        if (
          !option ||
          typeof option.optionId !== 'string' ||
          typeof option.name !== 'string' ||
          typeof option.kind !== 'string' ||
          !permissionKinds.has(option.kind as AcpPermissionOption['kind'])
        )
          return [];
        return [
          {
            optionId: option.optionId,
            name: option.name,
            kind: option.kind as AcpPermissionOption['kind'],
          },
        ];
      })
    : [];
  if (options.length === 0) return null;
  return {
    sessionId: record.sessionId,
    toolCall: { ...toolCall, toolCallId: toolCall.toolCallId },
    options,
  };
}
