import type { ProjectState } from '../../types/worker-state';
import type { KimiWebWsClient } from '../../utils/kimiWebWs';
import { loadKimiWebHistoryEntries } from './history';
import {
  KimiWebAdapter,
  mapKimiWebSessionsToProjects,
} from './kimiWebAdapter';

export type KimiWebBootstrapBridge = {
  subscribe(sessionIds: string[]): Promise<unknown>;
  applyHistory(entries: unknown[]): void;
  stop(): void;
};

export type KimiWebBootstrapCommit = {
  projects: Record<string, ProjectState>;
  selectedProjectId: string;
  selectedSessionId: string;
  selectedModel: string;
};

export async function bootstrapKimiWebWorkspace(options: {
  adapter: KimiWebAdapter;
  isCurrent: () => boolean;
  createClient: () => KimiWebWsClient;
  createBridge: (client: KimiWebWsClient) => KimiWebBootstrapBridge;
  commit: (state: KimiWebBootstrapCommit) => void;
}): Promise<{ client?: KimiWebWsClient; bridge?: KimiWebBootstrapBridge }> {
  let client: KimiWebWsClient | undefined;
  let bridge: KimiWebBootstrapBridge | undefined;
  const dispose = () => {
    bridge?.stop();
    client?.disconnect();
  };

  try {
    const [, , modelPage] = await options.adapter.initialize();
    if (!options.isCurrent()) return {};
    const sessions = await options.adapter.listSessions();
    if (!options.isCurrent()) return {};
    const projects = mapKimiWebSessionsToProjects(sessions);
    const first = sessions[0];

    if (first) {
      client = options.createClient();
      bridge = options.createBridge(client);
      await client.connect();
      if (!options.isCurrent()) {
        dispose();
        return {};
      }
      const history = await loadKimiWebHistoryEntries({
        sessionId: first.id,
        getMessages: options.adapter.restClient.getMessages,
        isCurrent: options.isCurrent,
      });
      if (!options.isCurrent()) {
        dispose();
        return {};
      }
      bridge.applyHistory(history.entries);
      await bridge.subscribe([first.id]);
      if (!options.isCurrent()) {
        dispose();
        return {};
      }
    }

    const availableModels = new Set(modelPage.items.map((model) => model.model));
    const selectedModel =
      first?.model && availableModels.has(first.model)
        ? first.model
        : (modelPage.items[0]?.model ?? '');
    options.commit({
      projects,
      selectedProjectId: first?.workspaceId ?? '',
      selectedSessionId: first?.id ?? '',
      selectedModel,
    });
    return { client, bridge };
  } catch (error) {
    dispose();
    throw error;
  }
}
