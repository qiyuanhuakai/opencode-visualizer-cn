import type { Ref } from 'vue';
import { acpBridgeHttpUrl } from '../backends/acp/bridgeUrl';
import { appendCodexBridgeToken, codexBridgeHttpUrl } from '../backends/codex/bridgeUrl';
import type { BackendKind } from '../backends/types';
import type { DesktopApi } from '../types/desktop';
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

export function useDesktopBridgeVersion(healthUrl: Ref<string>, desktopApi: DesktopApi | undefined) {
  let latestReport: Promise<unknown> = Promise.resolve();

  function report(connectionId: string, connection: ConnectedBridgeVersion) {
    const reportBridgeVersion = desktopApi?.reportBridgeVersion;
    if (!reportBridgeVersion) return;
    const version = connection.status === 'ready' ? connection.version : null;
    const request = reportBridgeVersion.call(desktopApi, { connectionId, version });
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
    return healthUrl.value.trim() === urlAtStart && latestReport === reportAtStart && state.value.status === 'ready';
  }

  return { state, refresh };
}
