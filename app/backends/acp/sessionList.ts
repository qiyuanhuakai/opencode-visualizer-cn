import type { BackendSessionInfo } from '../../types/backend-domain';
import { ACP_PROJECT_ID } from './bridgeUrl';
import { toRecord } from './wire';

export function parseAcpSessionList(value: unknown): BackendSessionInfo[] {
  const result = toRecord(value);
  const list = Array.isArray(result?.sessions) ? result.sessions : [];
  return list.flatMap((item) => {
    const record = toRecord(item);
    if (!record || typeof record.sessionId !== 'string' || typeof record.cwd !== 'string')
      return [];
    return [
      {
        id: record.sessionId,
        projectID: ACP_PROJECT_ID,
        directory: record.cwd,
        title: typeof record.title === 'string' ? record.title : record.sessionId,
        time:
          typeof record.updatedAt === 'string'
            ? { updated: Date.parse(record.updatedAt) }
            : undefined,
      },
    ];
  });
}
