import type { CodexJsonRpcId, CodexJsonRpcServerRequest } from './jsonRpcClient';

type JsonObject = Record<string, unknown>;

export type CodexPermissionReply = 'once' | 'always' | 'reject';
export type CodexRequestedPermissions = JsonObject;

export type CodexPermissionRequest = {
  requestId: CodexJsonRpcId;
  dialogId: string;
  sessionID: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason?: string;
  requestedPermissions: CodexRequestedPermissions;
};

export type McpElicitationOption = { value: string; label: string };

export type McpElicitationField = {
  key: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'select' | 'multiselect';
  required: boolean;
  defaultValue?: string | number | boolean | string[];
  options?: McpElicitationOption[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
};

type McpElicitationBase = {
  requestId: CodexJsonRpcId;
  dialogId: string;
  sessionID: string;
  turnId: string | null;
  serverName: string;
  message: string;
};

export type McpFormElicitationRequest = McpElicitationBase & {
  mode: 'form';
  fields: McpElicitationField[];
  required: string[];
};

export type McpUrlElicitationRequest = McpElicitationBase & {
  mode: 'url';
  url: string;
  elicitationId: string;
};

export type McpElicitationRequest = McpFormElicitationRequest | McpUrlElicitationRequest;
export type McpElicitationAction = 'accept' | 'decline' | 'cancel';

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function dialogId(prefix: string, requestId: CodexJsonRpcId) {
  return `${prefix}:${typeof requestId}:${String(requestId)}`;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function httpUrl(value: unknown) {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const protocol = new URL(raw).protocol;
    return protocol === 'https:' || protocol === 'http:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function parseOptions(schema: JsonObject): McpElicitationOption[] {
  const values = stringArray(schema.enum);
  if (values.length > 0) return values.map((value) => ({ value, label: value }));
  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf) ? schema.anyOf : [];
  return variants.flatMap((variant) => {
    if (!isRecord(variant) || typeof variant.const !== 'string') return [];
    return [{ value: variant.const, label: stringValue(variant.title) ?? variant.const }];
  });
}

function parseField(key: string, schema: unknown, required: Set<string>): McpElicitationField | null {
  if (!isRecord(schema)) return null;
  const rawType = stringValue(schema.type);
  const title = stringValue(schema.title) ?? key;
  const base = {
    key,
    label: title,
    description: stringValue(schema.description),
    required: required.has(key),
  };
  if (rawType === 'boolean') {
    return { ...base, type: 'boolean', defaultValue: typeof schema.default === 'boolean' ? schema.default : undefined };
  }
  if (rawType === 'number' || rawType === 'integer') {
    return {
      ...base,
      type: rawType,
      defaultValue: numberValue(schema.default),
      minimum: numberValue(schema.minimum),
      maximum: numberValue(schema.maximum),
    };
  }
  if (rawType === 'array' && isRecord(schema.items)) {
    const options = parseOptions(schema.items);
    if (options.length === 0) return null;
    return {
      ...base,
      type: 'multiselect',
      options,
      defaultValue: stringArray(schema.default),
      minimum: numberValue(schema.minItems),
      maximum: numberValue(schema.maxItems),
    };
  }
  if (rawType !== 'string') return null;
  const options = parseOptions(schema);
  if (options.length > 0) {
    return { ...base, type: 'select', options, defaultValue: stringValue(schema.default) };
  }
  return {
    ...base,
    type: 'string',
    defaultValue: stringValue(schema.default),
    minLength: numberValue(schema.minLength),
    maxLength: numberValue(schema.maxLength),
    format: stringValue(schema.format),
  };
}

export function parseCodexPermissionRequest(
  request: CodexJsonRpcServerRequest,
): CodexPermissionRequest | null {
  if (request.method !== 'item/permissions/requestApproval' || !isRecord(request.params)) return null;
  const { params } = request;
  if (
    typeof params.threadId !== 'string' ||
    typeof params.turnId !== 'string' ||
    typeof params.itemId !== 'string' ||
    typeof params.cwd !== 'string' ||
    !isRecord(params.permissions)
  ) return null;
  return {
    requestId: request.id,
    dialogId: dialogId('codex-permission', request.id),
    sessionID: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    cwd: params.cwd,
    reason: stringValue(params.reason),
    requestedPermissions: params.permissions,
  };
}

export function buildCodexPermissionResponse(
  requestedPermissions: CodexRequestedPermissions,
  reply: CodexPermissionReply,
) {
  return {
    permissions: reply === 'reject' ? {} : requestedPermissions,
    scope: reply === 'always' ? 'session' as const : 'turn' as const,
  };
}

export function parseMcpElicitationRequest(
  request: CodexJsonRpcServerRequest,
): McpElicitationRequest | null {
  if (request.method !== 'mcpServer/elicitation/request' || !isRecord(request.params)) return null;
  const params = request.params;
  const sessionID = stringValue(params.threadId);
  const serverName = stringValue(params.serverName);
  const message = stringValue(params.message);
  if (!sessionID || !serverName || !message) return null;
  const base = {
    requestId: request.id,
    dialogId: dialogId('codex-elicitation', request.id),
    sessionID,
    turnId: stringValue(params.turnId) ?? null,
    serverName,
    message,
  };
  if (params.mode === 'url') {
    const url = httpUrl(params.url);
    const elicitationId = stringValue(params.elicitationId);
    return url && elicitationId ? { ...base, mode: 'url', url, elicitationId } : null;
  }
  if (params.mode !== 'form' || !isRecord(params.requestedSchema)) return null;
  const properties = isRecord(params.requestedSchema.properties)
    ? params.requestedSchema.properties
    : {};
  const required = stringArray(params.requestedSchema.required);
  const requiredSet = new Set(required);
  const fields = Object.entries(properties)
    .map(([key, schema]) => parseField(key, schema, requiredSet))
    .filter((field): field is McpElicitationField => Boolean(field));
  return { ...base, mode: 'form', fields, required };
}

export function buildMcpElicitationResponse(
  action: McpElicitationAction,
  content?: JsonObject,
) {
  return {
    action,
    content: action === 'accept' ? content ?? {} : null,
    _meta: null,
  };
}
