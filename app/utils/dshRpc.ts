/**
 * dsh HTTP unary RPC client for the browser.
 *
 * Transport rule (IS-12 load-bearing decision, docs/dsh.md §4.2): the frontend
 * talks ONLY to vis_bridge and never to dsh directly. `baseUrl` is the bridge
 * HTTP prefix derived from the dsh bridge WS url
 * (`ws://localhost:23004/dsh/ws` → `http://localhost:23004/dsh` via
 * `deriveDshBridgeHttpUrl`); requests go to `<baseUrl>/<ns>/<method>`
 * (e.g. `/dsh/session/list`) with NO `/api` prefix — re-prefixing to
 * `/api/<ns>/<method>` happens on the bridge side. The browser holds neither
 * the dsh session cookie nor the dsh launch token: the only credential this
 * client sends is the vis_bridge token via `Authorization: Bearer <token>`
 * (the alternative `?token=` query form is what `bridge/bridgeHttp.js:22-26`
 * also accepts, but the header form is used here to keep the token out of
 * URLs, mirrors and logs).
 *
 * Wire contract (docs/dsh.md §5, pinned to dsh@0.2.0-rc.2 by the types in
 * `app/backends/dsh/types.ts`):
 *   - request: `client-request` envelope, `method` echoing the URL path,
 *     payload ALWAYS `{ args: { ... } }` (flat payloads are rejected by the
 *     0.2.0-rc.2 gateway with `gateway/internal`).
 *   - response: `server-response` with `result.ok` true/false; `result.ok ===
 *     false` carries a stable remote error code (`gateway/input-invalid`,
 *     `gateway/signature-invalid`, `MISSING_CREDENTIAL`, …) and is a BUSINESS
 *     error — never a network error.
 *   - results containing `Uint8Array` fields arrive as `multipart/form-data`:
 *     a `metadata` part holding the envelope JSON plus raw `bytes-N` parts.
 *
 * Not probed / not integrated: no live multipart endpoint has been exercised.
 * `parseDshMultipartResponse` is a defensive parser validated against
 * SYNTHETIC fixtures only; when the first real attachment endpoint is wired
 * up, re-capture the wire body and extend `app/utils/dshRpc.test.ts` with the
 * real fixture (same convention as `app/backends/dsh/fixtures.ts`).
 */

import {
  DshWireParseError,
  isDshClientRequest,
  isDshJsonValue,
  isDshServerResponse,
  type DshClientRequest,
  type DshJsonValue,
  type DshRemoteError,
  type DshServerResponse,
} from '../backends/dsh/types';

// Re-exported so callers get the envelope guards and the classified wire parse
// error from a single import surface (the contract module stays internal).
export { DshWireParseError };

// ---------------------------------------------------------------------------
// Typed error surface (stable codes; each documented failure has its own class)
// ---------------------------------------------------------------------------

/** Codes for transport-level failures (business codes ride verbatim). */
export type DshRpcTransportErrorCode =
  | 'invalid-base-url'
  | 'invalid-bridge-url'
  | 'invalid-method-path'
  | 'invalid-envelope'
  | 'network-failure'
  | 'http-401'
  | 'http-403'
  | 'http-404'
  | 'http-413'
  | 'http-415'
  | 'http-error';

export type DshRpcErrorCode = DshRpcTransportErrorCode | (string & {});

/** Base class for every classified failure this client can produce. */
export class DshRpcError extends Error {
  /** Stable machine code: remote code verbatim, or a `DshRpcTransportErrorCode`. */
  readonly code: DshRpcErrorCode;
  readonly rpcId: string | null;
  readonly method: string | null;
  readonly status?: number;
  readonly details?: unknown;

  constructor(
    message: string,
    options: {
      code: DshRpcErrorCode;
      rpcId?: string | null;
      method?: string | null;
      status?: number;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'DshRpcError';
    this.code = options.code;
    this.rpcId = options.rpcId ?? null;
    this.method = options.method ?? null;
    this.status = options.status;
    this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Business error: the server answered with `result.ok === false`. The remote
 * `code` (`gateway/input-invalid`, `gateway/signature-invalid`, …) is kept
 * VERBATIM as the stable classification; it is never a network error.
 */
export class DshRemoteRpcError extends DshRpcError {
  readonly remote: DshRemoteError;

  constructor(remote: DshRemoteError, rpcId: string, method: string | null = null) {
    super(`dsh rpc ${method ?? '<unknown>'} failed [${remote.code}] (rpcId ${rpcId}): ${remote.message}`, {
      code: remote.code,
      rpcId,
      method,
      details: remote.details,
    });
    this.name = 'DshRemoteRpcError';
    this.remote = remote;
  }
}

/** Session credential missing upstream (`MISSING_CREDENTIAL` error envelope). */
export class DshMissingCredentialError extends DshRemoteRpcError {
  constructor(remote: DshRemoteError, rpcId: string, method: string | null = null) {
    super(remote, rpcId, method);
    this.name = 'DshMissingCredentialError';
  }
}

/** fetch() itself rejected (connection refused, DNS, abort). */
export class DshRpcNetworkError extends DshRpcError {
  constructor(method: string, rpcId: string, cause: unknown) {
    super(`dsh rpc ${method} network failure (rpcId ${rpcId}): ${describeCause(cause)}`, {
      code: 'network-failure',
      rpcId,
      method,
      cause,
    });
    this.name = 'DshRpcNetworkError';
  }
}

/** Non-2xx HTTP status from the bridge/dsh chain. */
export class DshRpcHttpError extends DshRpcError {
  readonly body?: string;

  constructor(
    status: number,
    options: { method: string; rpcId: string; body?: string },
    code: DshRpcTransportErrorCode = 'http-error',
  ) {
    const bodyNote = options.body ? `: ${options.body}` : '';
    super(`dsh rpc ${options.method} failed with HTTP ${status} (rpcId ${options.rpcId})${bodyNote}`, {
      code,
      rpcId: options.rpcId,
      method: options.method,
      status,
    });
    this.name = 'DshRpcHttpError';
    this.body = options.body;
  }
}

/** Bridge/dsh rejected the credential (401). Thrown immediately — never retried. */
export class DshRpcUnauthorizedError extends DshRpcHttpError {
  constructor(options: { method: string; rpcId: string; body?: string }) {
    super(401, options, 'http-401');
    this.name = 'DshRpcUnauthorizedError';
  }
}

/** Trust fence rejected the request (Host/Origin/cookie authority, 403). */
export class DshRpcForbiddenError extends DshRpcHttpError {
  constructor(options: { method: string; rpcId: string; body?: string }) {
    super(403, options, 'http-403');
    this.name = 'DshRpcForbiddenError';
  }
}

/** Unknown route or non-POST method (404). */
export class DshRpcNotFoundError extends DshRpcHttpError {
  constructor(options: { method: string; rpcId: string; body?: string }) {
    super(404, options, 'http-404');
    this.name = 'DshRpcNotFoundError';
  }
}

/** Request body exceeded the 300 MiB cap (413). */
export class DshRpcPayloadTooLargeError extends DshRpcHttpError {
  constructor(options: { method: string; rpcId: string; body?: string }) {
    super(413, options, 'http-413');
    this.name = 'DshRpcPayloadTooLargeError';
  }
}

/** Content-Type not accepted by the gateway (415, e.g. non-JSON request). */
export class DshRpcUnsupportedMediaTypeError extends DshRpcHttpError {
  constructor(options: { method: string; rpcId: string; body?: string }) {
    super(415, options, 'http-415');
    this.name = 'DshRpcUnsupportedMediaTypeError';
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Map an HTTP status to its typed error class. Business (`result.ok === false`)
 * envelopes never reach here — they are classified by
 * `classifyDshRemoteError`.
 */
export function classifyDshHttpStatusError(
  status: number,
  context: { method: string; rpcId: string; body?: string },
): DshRpcHttpError {
  const ctor = HTTP_STATUS_CLASSES[status];
  if (ctor) return new ctor(context);
  return new DshRpcHttpError(status, context);
}

const HTTP_STATUS_CLASSES: Partial<
  Record<number, new (options: { method: string; rpcId: string; body?: string }) => DshRpcHttpError>
> = {
  401: DshRpcUnauthorizedError,
  403: DshRpcForbiddenError,
  404: DshRpcNotFoundError,
  413: DshRpcPayloadTooLargeError,
  415: DshRpcUnsupportedMediaTypeError,
};

/**
 * Classify a remote error envelope. `MISSING_CREDENTIAL` (the session-cookie
 * fence, docs/dsh.md §4.2 step 4) gets its own class; every other stable
 * remote code keeps its verbatim value on a `DshRemoteRpcError`.
 */
export function classifyDshRemoteError(
  remote: DshRemoteError,
  rpcId: string,
  method: string | null = null,
): DshRemoteRpcError {
  if (remote.code === 'MISSING_CREDENTIAL') {
    return new DshMissingCredentialError(remote, rpcId, method);
  }
  return new DshRemoteRpcError(remote, rpcId, method);
}

// ---------------------------------------------------------------------------
// Pure helpers: bridge URL derivation + request URL/envelope construction
// ---------------------------------------------------------------------------

/**
 * Derive the bridge HTTP prefix from the dsh bridge WebSocket URL.
 * `ws://localhost:23004/dsh/ws` → `http://localhost:23004/dsh`
 * (`wss:` maps to `https:`). The `/ws` suffix is stripped and any query
 * (e.g. a `?token=` used for the WS handshake) is dropped — HTTP calls carry
 * the bridge token in the Authorization header instead.
 *
 * The canonical WS URL constant (`DEFAULT_DSH_BRIDGE_URL`) lives with the
 * backend registry; this module only performs the derivation.
 */
export function deriveDshBridgeHttpUrl(wsUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    throw new DshRpcError('not a URL', { code: 'invalid-bridge-url' });
  }
  if (parsed.username || parsed.password) {
    throw new DshRpcError('bridge url must not embed credentials', { code: 'invalid-bridge-url' });
  }
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  else throw new DshRpcError(`unsupported scheme ${parsed.protocol}`, { code: 'invalid-bridge-url' });
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/ws\/?$/u, '').replace(/\/+$/u, '');
  if (!parsed.pathname) throw new DshRpcError('bridge url has no /dsh prefix', { code: 'invalid-bridge-url' });
  return parsed.toString().replace(/\/+$/u, '');
}

/** Path segments allowed by the dsh gateway (docs/dsh.md §5.1). */
const METHOD_SEGMENT = /^[A-Za-z0-9_$.-]+$/u;

/**
 * Build the absolute request URL `<baseUrl>/<namespace>/<method>`.
 * No `/api` prefix is added — the bridge re-prefixes on its side.
 */
export function buildDshRpcUrl(baseUrl: string, namespace: string, method: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/u, '');
  if (!trimmedBase) {
    throw new DshRpcError('baseUrl is required (bridge HTTP prefix)', { code: 'invalid-base-url' });
  }
  if (/^wss?:\/\//u.test(trimmedBase)) {
    throw new DshRpcError(
      'baseUrl must be the bridge HTTP prefix; derive it with deriveDshBridgeHttpUrl()',
      { code: 'invalid-base-url' },
    );
  }
  assertMethodSegment(namespace);
  assertMethodSegment(method);
  return `${trimmedBase}/${encodeURIComponent(namespace)}/${encodeURIComponent(method)}`;
}

function assertMethodSegment(segment: string): void {
  // The gateway charset admits dots, so `.`/`..` need an explicit guard
  // (docs/dsh.md §5.1: `..` and empty segments are rejected).
  if (!METHOD_SEGMENT.test(segment) || segment === '.' || segment === '..') {
    throw new DshRpcError(
      `method path segment ${JSON.stringify(segment)} must match [A-Za-z0-9_$.-]+ and not be a dot segment`,
      { code: 'invalid-method-path' },
    );
  }
}

/**
 * Build a `client-request` envelope: `method` echoes the URL path and the
 * payload is ALWAYS wrapped as `{ args: { ... } }` (0.2.0-rc.2 requirement,
 * docs/dsh.md §5.1/§5.3). The built envelope is re-validated against the
 * Todo 3 guard so non-JSON args can never be serialized silently.
 */
export function buildDshClientRequest(
  method: string,
  args: Record<string, DshJsonValue>,
  rpcId: string,
): DshClientRequest {
  if (!rpcId.trim()) {
    throw new DshRpcError('rpcId must be a non-empty string', { code: 'invalid-envelope' });
  }
  const request: DshClientRequest = {
    type: 'client-request',
    rpcId,
    method,
    payload: { args },
  };
  if (!isDshClientRequest(request)) {
    throw new DshRpcError(
      `args must be a JSON-valued record (dsh rpc ${method}, rpcId ${rpcId})`,
      { code: 'invalid-envelope', rpcId, method },
    );
  }
  return request;
}

// ---------------------------------------------------------------------------
// Pure helpers: server-response envelope parsing
// ---------------------------------------------------------------------------

/**
 * Validate an already-decoded value as a `server-response` envelope and
 * enforce the `rpcId` echo. Envelope-shape failures reuse the Todo 3
 * classified `DshWireParseError` so wire-level mistakes stay typed.
 */
export function parseDshServerResponseValue(
  value: unknown,
  expectedRpcId?: string,
): DshServerResponse {
  if (!isDshServerResponse(value)) {
    throw new DshWireParseError(
      'bad-value',
      'dsh rpc: response is not a server-response envelope ({type:"server-response",rpcId,result:{ok,…}})',
      value,
    );
  }
  if (expectedRpcId !== undefined && value.rpcId !== expectedRpcId) {
    throw new DshWireParseError(
      'bad-value',
      `dsh rpc: rpcId echo mismatch: expected ${expectedRpcId}, got ${value.rpcId}`,
      value,
    );
  }
  return value;
}

/**
 * Parse a response body as a `server-response` envelope. Empty and non-JSON
 * bodies are classified (`not-json`) instead of being coerced — the response
 * is never ASSUMED to be JSON.
 */
export function parseDshServerResponseText(text: string, expectedRpcId?: string): DshServerResponse {
  if (!text.trim()) {
    throw new DshWireParseError(
      'not-json',
      `dsh rpc: empty response body (rpcId ${expectedRpcId ?? '<unknown>'})`,
      text,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new DshWireParseError(
      'not-json',
      `dsh rpc: response body is not JSON (rpcId ${expectedRpcId ?? '<unknown>'}): ${text.slice(0, 120)}`,
      text,
    );
  }
  return parseDshServerResponseValue(decoded, expectedRpcId);
}

/**
 * Unwrap a validated `server-response`: `ok: true` returns the value,
 * `ok: false` throws a classified business error (never a network error).
 */
export function unwrapDshServerResponse(
  response: DshServerResponse,
  expectedRpcId?: string,
): DshJsonValue {
  const envelope = expectedRpcId === undefined ? response : parseDshServerResponseValue(response, expectedRpcId);
  if (envelope.result.ok) return envelope.result.value;
  throw classifyDshRemoteError(envelope.result.error, envelope.rpcId);
}

// ---------------------------------------------------------------------------
// Pure helpers: multipart/form-data response parsing (synthetic-fixture only)
// ---------------------------------------------------------------------------

/**
 * Parsed multipart result: the envelope JSON from the `metadata` part plus the
 * raw byte parts in wire order. `bytes[i]` aligns with the i-th entry of the
 * metadata's `attachments` array (`{path, codec:"bytes", part}` names the
 * part; positional order is the documented fallback).
 */
export type DshMultipartParseResult = {
  readonly metadata: DshJsonValue;
  readonly bytes: readonly Uint8Array[];
};

const METADATA_PART_NAME = 'metadata';

/**
 * Defensively parse a `multipart/form-data` response body.
 *
 * SYNTHETIC-FIXTURE ONLY: no live multipart endpoint has been probed or
 * integrated (see the module comment). Parts are located by their
 * `Content-Disposition: form-data; name="…"` header; the `metadata` part is
 * decoded as UTF-8 JSON, every other part is preserved as raw bytes. Both
 * CRLF and LF-only line endings are tolerated. Malformed bodies (missing
 * boundary parameter, truncated body without the closing delimiter, missing
 * or non-JSON metadata) throw a classified `DshWireParseError` instead of
 * being silently coerced.
 */
export function parseDshMultipartResponse(
  contentType: string,
  body: Uint8Array,
): DshMultipartParseResult {
  const boundaryMatch = /boundary="?([^";]+)"?/iu.exec(contentType);
  const boundary = boundaryMatch?.[1];
  if (!boundary) {
    throw new DshWireParseError('bad-value', 'dsh multipart: content-type carries no boundary', contentType);
  }

  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const segments = splitBytes(body, delimiter);
  if (segments.length < 2) {
    throw new DshWireParseError(
      'missing-field',
      'dsh multipart: body carries no part delimiters',
      body,
    );
  }
  if (segments[0]!.length > 0) {
    throw new DshWireParseError(
      'bad-value',
      'dsh multipart: truncated body — no complete part delimiters found',
      body,
    );
  }

  const parts: Array<{ name: string; bytes: Uint8Array }> = [];
  let closed = false;
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (startsWith(segment, ENCODER.encode('--'))) {
      closed = true;
      break;
    }
    const part = parseMultipartPart(segment, index - 1);
    if (part) parts.push(part);
  }
  if (!closed) {
    throw new DshWireParseError(
      'bad-value',
      'dsh multipart: truncated body — closing boundary delimiter missing',
      body,
    );
  }

  const metadataPart = parts.find((part) => part.name === METADATA_PART_NAME);
  if (!metadataPart) {
    throw new DshWireParseError(
      'missing-field',
      `dsh multipart: no "${METADATA_PART_NAME}" part in response`,
      body,
    );
  }
  const metadataText = new TextDecoder().decode(metadataPart.bytes);
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw new DshWireParseError(
      'not-json',
      `dsh multipart: ${METADATA_PART_NAME} part is not JSON: ${metadataText.slice(0, 120)}`,
      metadataText,
    );
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new DshWireParseError(
      'not-object',
      `dsh multipart: ${METADATA_PART_NAME} part is not a JSON object`,
      metadata,
    );
  }
  if (!isDshJsonValue(metadata)) {
    throw new DshWireParseError(
      'bad-value',
      `dsh multipart: ${METADATA_PART_NAME} part is not a JSON value`,
      metadata,
    );
  }

  return {
    metadata,
    bytes: parts.filter((part) => part !== metadataPart).map((part) => part.bytes),
  };
}

const ENCODER = new TextEncoder();

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const last = haystack.length - needle.length;
  for (let index = from; index <= last; index += 1) {
    if (startsWith(haystack.subarray(index), needle)) return index;
  }
  return -1;
}

/** Split on every delimiter occurrence; the first chunk is the preamble. */
function splitBytes(body: Uint8Array, delimiter: Uint8Array): Uint8Array[] {
  const segments: Uint8Array[] = [];
  let start = 0;
  for (;;) {
    const found = indexOfBytes(body, delimiter, start);
    if (found === -1) {
      segments.push(body.subarray(start));
      return segments;
    }
    segments.push(body.subarray(start, found));
    start = found + delimiter.length;
  }
}

function parseMultipartPart(
  segment: Uint8Array,
  index: number,
): { name: string; bytes: Uint8Array } | null {
  // Drop the leading CRLF (or LF) that precedes each part's headers.
  let cursor = 0;
  if (segment[cursor] === 0x0d && segment[cursor + 1] === 0x0a) cursor += 2;
  else if (segment[cursor] === 0x0a) cursor += 1;
  if (cursor === segment.length) return null; // stray empty segment

  const headerEnd = findHeaderEnd(segment, cursor);
  if (!headerEnd) {
    throw new DshWireParseError(
      'bad-value',
      `dsh multipart: part ${index} has no header/body separator`,
      segment,
    );
  }
  const headers = new TextDecoder().decode(segment.subarray(cursor, headerEnd.start));
  const nameMatch = /name="([^"]*)"/iu.exec(headers) ?? /name=([^";\r\n]+)/iu.exec(headers);
  const name = nameMatch?.[1]?.trim();
  if (!name) {
    throw new DshWireParseError(
      'missing-field',
      `dsh multipart: part ${index} has no Content-Disposition name`,
      headers,
    );
  }
  let end = segment.length;
  // The CRLF before the next delimiter belongs to the delimiter.
  if (segment[end - 1] === 0x0a) {
    end -= 1;
    if (segment[end - 1] === 0x0d) end -= 1;
  }
  return { name, bytes: segment.subarray(headerEnd.end, end) };
}

function findHeaderEnd(segment: Uint8Array, from: number): { start: number; end: number } | null {
  const crlf = indexOfBytes(segment, ENCODER.encode('\r\n\r\n'), from);
  const lf = indexOfBytes(segment, ENCODER.encode('\n\n'), from);
  if (crlf === -1 && lf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { start: crlf, end: crlf + 4 };
  return { start: lf, end: lf + 2 };
}

/**
 * Unwrap a parsed multipart response to the ok value of its metadata
 * envelope (business errors from the metadata envelope are classified the
 * same way as unary responses).
 */
export function unwrapDshMultipartResponse(
  result: DshMultipartParseResult,
  expectedRpcId?: string,
): DshJsonValue {
  const envelope = parseDshServerResponseValue(result.metadata, expectedRpcId);
  if (envelope.result.ok) return envelope.result.value;
  throw classifyDshRemoteError(envelope.result.error, envelope.rpcId, 'multipart-metadata');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type DshRpcTokenProvider = () =>
  | string
  | null
  | undefined
  | Promise<string | null | undefined>;

/** Injectable fetch surface (defaults to the global fetch; no dependencies added). */
export type DshRpcFetcher = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export type DshRpcClientOptions = {
  /** vis_bridge HTTP prefix, e.g. `http://localhost:23004/dsh` (never the dsh upstream). */
  baseUrl: string;
  /** vis_bridge token provider; sent as `Authorization: Bearer`. */
  getBridgeToken?: DshRpcTokenProvider;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetcher?: DshRpcFetcher;
};

export type DshRpcCallOptions = {
  /**
   * Explicit rpcId. REQUIRED for prompt-style calls whose id must bind to a
   * client-generated requestId (Todo 20/25); defaults to the client's
   * monotonic auto-increment counter.
   */
  rpcId?: string;
  signal?: AbortSignal;
};

export type DshRpcClient = {
  /** Unary call; a multipart response is unwrapped to its metadata value. */
  call(
    namespace: string,
    method: string,
    args?: Record<string, DshJsonValue>,
    options?: DshRpcCallOptions,
  ): Promise<DshJsonValue>;
  /** Unary call for attachment endpoints: `{metadata, bytes}` (synthetic-fixture parser). */
  callMultipart(
    namespace: string,
    method: string,
    args?: Record<string, DshJsonValue>,
    options?: DshRpcCallOptions,
  ): Promise<DshMultipartParseResult>;
  /** Next auto-increment rpcId (exposed for logging/pre-binding). */
  nextRpcId(): string;
};

const JSON_CONTENT_TYPE = 'application/json';
const MAX_ERROR_BODY_CHARS = 512;

function defaultFetcher(
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const fetchImpl = globalThis.fetch;
  if (!fetchImpl) {
    throw new DshRpcError('no fetch implementation available', { code: 'network-failure' });
  }
  return fetchImpl(url, init);
}

export function createDshRpcClient(options: DshRpcClientOptions): DshRpcClient {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/u, '');
  if (!baseUrl) {
    throw new DshRpcError('baseUrl is required (bridge HTTP prefix)', { code: 'invalid-base-url' });
  }
  const getBridgeToken = options.getBridgeToken;
  const fetcher: DshRpcFetcher = options.fetcher ?? defaultFetcher;

  let counter = 0;

  function nextRpcId(): string {
    counter += 1;
    return `dsh-${counter}`;
  }

  async function buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'content-type': JSON_CONTENT_TYPE };
    const token = (await getBridgeToken?.())?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * Single-shot invoke. There is deliberately NO retry: a 401 (or any other
   * classified failure) must surface immediately so the caller can re-auth or
   * fail loudly instead of looping with a stale credential.
   */
  async function invoke(
    namespace: string,
    method: string,
    args: Record<string, DshJsonValue>,
    callOptions: DshRpcCallOptions | undefined,
    mode: 'value' | 'multipart',
  ): Promise<DshJsonValue | DshMultipartParseResult> {
    const rpcId = callOptions?.rpcId ?? nextRpcId();
    const wireMethod = `${namespace}/${method}`;
    const request = buildDshClientRequest(wireMethod, args, rpcId);
    const url = buildDshRpcUrl(baseUrl, namespace, method);
    const headers = await buildHeaders();

    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: callOptions?.signal,
      });
    } catch (cause) {
      throw new DshRpcNetworkError(wireMethod, rpcId, cause);
    }

    if (response.status < 200 || response.status >= 300) {
      throw classifyDshHttpStatusError(response.status, {
        method: wireMethod,
        rpcId,
        body: await readErrorBody(response),
      });
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/')) {
      const parsed = parseDshMultipartResponse(contentType, new Uint8Array(await response.arrayBuffer()));
      const value = unwrapDshMultipartResponse(parsed, rpcId);
      return mode === 'multipart' ? parsed : value;
    }

    const text = await response.text().catch(() => '');
    const envelope = parseDshServerResponseText(text, rpcId);
    return unwrapDshServerResponse(envelope);
  }

  async function readErrorBody(response: Response): Promise<string | undefined> {
    try {
      const text = await response.text();
      const trimmed = text.trim();
      return trimmed ? trimmed.slice(0, MAX_ERROR_BODY_CHARS) : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    call: (namespace, method, args = {}, callOptions) =>
      invoke(namespace, method, args, callOptions, 'value') as Promise<DshJsonValue>,
    callMultipart: (namespace, method, args = {}, callOptions) =>
      invoke(namespace, method, args, callOptions, 'multipart') as Promise<DshMultipartParseResult>,
    nextRpcId,
  };
}
