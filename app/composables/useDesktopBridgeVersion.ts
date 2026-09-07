import type { Ref } from 'vue';
import { acpBridgeHttpUrl } from '../backends/acp/bridgeUrl';
import { appendCodexBridgeToken, codexBridgeHttpUrl } from '../backends/codex/bridgeUrl';
import type { BackendKind } from '../backends/types';
import type { DesktopApi, DesktopBridgeEndpointLocality } from '../types/desktop';
import {
  useConnectedBridgeVersion,
  type ConnectedBridgeVersion,
} from './useConnectedBridgeVersion';

export interface DesktopBridgeHealthTarget {
  readonly backendKind: BackendKind;
  readonly acpBridgeUrl: string;
  readonly acpBridgeToken: string;
  readonly codexBridgeUrl: string;
  readonly codexBridgeToken: string;
}

export function resolveDesktopBridgeHealthUrl(target: DesktopBridgeHealthTarget): string {
  try {
    if (target.backendKind === 'acp') {
      return appendCodexBridgeToken(
        acpBridgeHttpUrl(target.acpBridgeUrl, '/healthz'),
        target.acpBridgeToken,
      );
    }
    // Codex and OpenCode share the configured common bridge; the OpenCode server
    // URL is never a bridge health endpoint.
    return appendCodexBridgeToken(
      codexBridgeHttpUrl(target.codexBridgeUrl, '/healthz'),
      target.codexBridgeToken,
    );
  } catch {
    return '';
  }
}

export function classifyDesktopBridgeEndpoint(url: string): DesktopBridgeEndpointLocality {
  if (!url.trim()) return 'unknown';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'unknown';
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    if (
      hostname === 'localhost' ||
      hostname === 'localhost.' ||
      hostname === '::1' ||
      /^127(?:\.\d{1,3}){3}$/u.test(hostname)
    ) {
      return 'local';
    }
    const mappedLoopback = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u.exec(hostname);
    if (mappedLoopback && Number.parseInt(mappedLoopback[1], 16) >>> 8 === 127) return 'local';
    return 'remote';
  } catch {
    return 'unknown';
  }
}

export function useDesktopBridgeVersion(
  healthUrl: Ref<string>,
  desktopApi: DesktopApi | undefined,
) {
  let latestReport: Promise<unknown> = Promise.resolve();

  function report(connectionId: string, connection: ConnectedBridgeVersion) {
    const reportBridgeVersion = desktopApi?.reportBridgeVersion;
    if (!reportBridgeVersion) return;
    const version = connection.status === 'ready' ? connection.version : null;
    const endpointLocality = classifyDesktopBridgeEndpoint(healthUrl.value);
    const request = reportBridgeVersion.call(desktopApi, {
      connectionId,
      endpointLocality,
      version,
    });
    void request.catch(() => undefined);
    latestReport = request;
  }

  const { state, refresh: refreshHealth } = useConnectedBridgeVersion(healthUrl, {
    onConnectionChange: report,
  });

  async function refresh(): Promise<boolean> {
    if (!desktopApi?.reportBridgeVersion) return false;
    const urlAtStart = healthUrl.value.trim();
    if (!urlAtStart) return false;
    await refreshHealth();
    if (healthUrl.value.trim() !== urlAtStart) return false;
    if (state.value.status !== 'ready') return false;
    const reportAtStart = latestReport;
    try {
      await reportAtStart;
    } catch {
      return false;
    }
    return (
      healthUrl.value.trim() === urlAtStart &&
      latestReport === reportAtStart &&
      state.value.status === 'ready'
    );
  }

  return { state, refresh };
}
