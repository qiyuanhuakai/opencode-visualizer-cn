import type { KimiWebNormalizeOp } from '../backends/kimiWeb/normalize';
import type { ProjectState } from '../types/worker-state';
import {
  mapKimiWebSession,
  upsertKimiWebSessionIntoProjects,
} from '../backends/kimiWeb/kimiWebAdapter';
import { asString, isRecord } from '../backends/kimiWeb/wire';
import type { KimiWebFrameOrigin } from './kimiWebMessageBridgeTypes';

export function applyKimiWebSessionEvent(
  projects: Record<string, ProjectState>,
  event: Extract<KimiWebNormalizeOp, { kind: 'session' }>,
  origin: KimiWebFrameOrigin = 'live',
): void {
  if (event.phase === 'created') {
    const raw = event.session;
    if (!isRecord(raw) || !asString(raw.id) || !asString(raw.workspace_id)) return;
    const metadata = isRecord(raw.metadata) ? raw.metadata : {};
    const mapped = mapKimiWebSession({
        id: asString(raw.id),
        workspace_id: asString(raw.workspace_id),
        title: asString(raw.title),
        busy: origin !== 'durable-replay' && raw.busy === true,
        main_turn_active: raw.main_turn_active === true,
        last_turn_reason: asString(raw.last_turn_reason) === 'completed' || asString(raw.last_turn_reason) === 'cancelled' || asString(raw.last_turn_reason) === 'failed'
          ? asString(raw.last_turn_reason) as 'completed' | 'cancelled' | 'failed'
          : undefined,
        pending_interaction: 'none',
        archived: raw.archived === true,
        archived_at: asString(raw.archived_at),
        created_at: asString(raw.created_at),
        updated_at: asString(raw.updated_at),
        metadata: {
          cwd: asString(metadata.cwd) || '/',
          parent_session_id: asString(metadata.parent_session_id) || undefined,
        },
      });
    if (origin === 'durable-replay') {
      const existing = Object.values(projects).flatMap((project) => Object.values(project.sandboxes))
        .map((sandbox) => sandbox.sessions[mapped.id]).find(Boolean);
      if (existing?.status === 'busy' || existing?.status === 'idle') mapped.status = existing.status;
    }
    upsertKimiWebSessionIntoProjects(projects, mapped);
    return;
  }
  for (const project of Object.values(projects)) {
    for (const sandbox of Object.values(project.sandboxes)) {
      const session = sandbox.sessions[event.sessionId];
      if (!session) continue;
      switch (event.phase) {
        case 'deleted':
          delete sandbox.sessions[event.sessionId];
          sandbox.rootSessions = sandbox.rootSessions.filter((id) => id !== event.sessionId);
          break;
        case 'archived':
          session.timeArchived ??= Date.now();
          break;
        case 'meta':
          if (event.title !== undefined) session.title = event.title;
          else if (typeof event.patch?.title === 'string') session.title = event.patch.title;
          if (event.patch?.archived === false) session.timeArchived = undefined;
          else if (event.patch?.archived === true) session.timeArchived ??= Date.now();
          break;
        case 'work-changed':
          if (origin === 'durable-replay') break;
          if (event.busy !== undefined || event.mainTurnActive !== undefined) {
            session.status = event.busy || event.mainTurnActive
              ? 'busy'
              : session.status === 'busy' || session.status === 'idle'
                ? 'idle' : 'unknown';
          }
          break;
        case 'status-changed':
          if (origin === 'durable-replay') break;
          if (event.status === 'busy' || event.status === 'idle' || event.status === 'retry') {
            if (event.status === 'retry' && session.status === 'unknown') break;
            if (event.status !== 'idle' || session.status !== 'unknown') session.status = event.status;
          }
          break;
      }
    }
  }
}
