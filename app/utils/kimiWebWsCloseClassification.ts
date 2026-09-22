/**
 * Close-error classification for the kimi web WebSocket client.
 *
 * The browser WebSocket API cannot observe an upstream HTTP status, so a close
 * code alone can never prove an "upstream 401". Every non-manual close is run
 * through a REST precheck (`GET <proxy>/api/v1/meta`) that tells apart:
 * - `bridge-credential`: the vis_bridge proxy rejected our bridge token
 *   (`{error:'Unauthorized'}` / `{error:'Forbidden origin'}`, no kimi envelope);
 * - `kimi-credential`: the bridge token was accepted but kimi web rejected the
 *   credentials (kimi envelope with a numeric `code`) or the bridge could not
 *   read `~/.kimi-code/server.token` (`KIMI_WEB_TOKEN_UNAVAILABLE` /
 *   `KIMI_TOKEN_*`);
 * - `upstream-unreachable`: the precheck itself could not reach the proxy or
 *   the bridge reported the kimi upstream as unreachable/timeout.
 * A healthy precheck yields `heartbeat-timeout` (measured 1001 close) or
 * `unknown` — never a credential claim.
 */

import { asRecord, errorMessage } from './kimiWebWsProtocol';

export type KimiWebWsFailureKind =
  | 'bridge-credential'
  | 'kimi-credential'
  | 'upstream-unreachable'
  | 'heartbeat-timeout'
  | 'unknown';

export type KimiWebWsCloseClassification = {
  kind: KimiWebWsFailureKind;
  detail: string;
  status?: number;
};

export type KimiWebWsCloseInfo = {
  code: number;
  reason: string;
  wasClean: boolean;
  /** `true` when `disconnect()` initiated the close; classification is null then. */
  manual: boolean;
  classification: KimiWebWsCloseClassification | null;
};

/** Minimal structural view of `fetch`'s response; keeps browser/Node fetchers interchangeable. */
export type KimiWebWsFetchResponse = { status: number; json(): Promise<unknown> };

export type KimiWebWsFetcher = (
  input: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<KimiWebWsFetchResponse>;

export type KimiWebWsClosePrecheckOptions = {
  code: number;
  reason: string;
  /** Bridge REST proxy root, e.g. `http://localhost:23004/kimi-web`. */
  proxyHttpUrl: string;
  /** `Authorization` value for the bridge; omitted when the bridge is tokenless. */
  authorization?: string;
  fetcher?: KimiWebWsFetcher;
  timeoutMs?: number;
};

const DEFAULT_PRECHECK_TIMEOUT_MS = 4000;
const BRIDGE_TOKEN_ERROR_CODES = ['KIMI_WEB_TOKEN_UNAVAILABLE'];

/** Numeric `code` marks a kimi REST envelope; bridge proxy errors use a string code. */
function kimiEnvelopeCode(body: unknown) {
  const code = asRecord(body)?.code;
  return typeof code === 'number' ? code : undefined;
}

function bridgeProxyErrorCode(body: unknown) {
  const code = asRecord(body)?.code;
  return typeof code === 'string' ? code : undefined;
}

export async function classifyKimiWebWsClose(
  options: KimiWebWsClosePrecheckOptions,
): Promise<KimiWebWsCloseClassification> {
  const heartbeat = options.code === 1001 && /heartbeat/i.test(options.reason);
  const fetcher = options.fetcher;
  if (!fetcher) {
    return {
      kind: 'unknown',
      detail: 'No fetch implementation is available to classify the close.',
    };
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = setTimeout(
    () => controller?.abort(),
    options.timeoutMs ?? DEFAULT_PRECHECK_TIMEOUT_MS,
  );
  let response: KimiWebWsFetchResponse;
  try {
    response = await fetcher(`${options.proxyHttpUrl}/api/v1/meta`, {
      method: 'GET',
      headers: options.authorization ? { Authorization: options.authorization } : {},
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    clearTimeout(timer);
    return {
      kind: 'upstream-unreachable',
      detail: `Kimi Web REST precheck could not reach the bridge proxy: ${errorMessage(error)}`,
    };
  }
  clearTimeout(timer);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const kimiCode = kimiEnvelopeCode(body);

  if (response.status === 200 && kimiCode === 0) {
    return heartbeat
      ? {
          kind: 'heartbeat-timeout',
          status: 200,
          detail:
            'kimi web closed the socket with 1001 "heartbeat timeout" while the REST precheck was healthy.',
        }
      : {
          kind: 'unknown',
          status: 200,
          detail: 'The bridge and kimi web answered the REST precheck; the close looks transient.',
        };
  }
  if (response.status === 401 || response.status === 403) {
    return kimiCode !== undefined
      ? {
          kind: 'kimi-credential',
          status: response.status,
          detail: `kimi web rejected the bridge credentials (HTTP ${response.status}, code ${kimiCode}).`,
        }
      : {
          kind: 'bridge-credential',
          status: response.status,
          detail: `The vis_bridge proxy rejected the request (HTTP ${response.status}).`,
        };
  }
  const proxyCode = bridgeProxyErrorCode(body);
  if (
    proxyCode !== undefined &&
    (BRIDGE_TOKEN_ERROR_CODES.includes(proxyCode) || proxyCode.startsWith('KIMI_TOKEN_'))
  ) {
    return {
      kind: 'kimi-credential',
      status: response.status,
      detail: `The bridge could not read the kimi web token (${proxyCode}).`,
    };
  }
  if (response.status >= 500) {
    return {
      kind: 'upstream-unreachable',
      status: response.status,
      detail:
        proxyCode !== undefined
          ? `The bridge reported ${proxyCode} while reaching kimi web.`
          : `The bridge reported HTTP ${response.status} while reaching kimi web.`,
    };
  }
  return {
    kind: 'unknown',
    status: response.status,
    detail: `Unexpected REST precheck response (HTTP ${response.status}).`,
  };
}
