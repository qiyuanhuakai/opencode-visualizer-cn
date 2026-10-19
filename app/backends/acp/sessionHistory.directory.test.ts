import { describe, expect, it, vi } from 'vitest';
import { loadAcpSessionHistory } from './sessionHistory';
import { createAcpSessionState, type AcpSessionState } from './history';
import type { BackendSessionInfo } from '../../types/backend-domain';

/**
 * The REAL ACP history loader, driven with a session whose OWN directory is
 * `/original-project` while the caller passes the ambient `/other-project`.
 *
 * `loadAcpSessionHistory` builds the `session/load` / `session/resume` params as
 * `cwd: options.directory ?? state.info.directory ?? ''`, so the caller's
 * directory takes priority over the session's own. That priority is the defect
 * the App's history reader feeds: a participant whose session belongs to one
 * workspace is handed to the agent with the directory the user happens to have
 * selected, and the agent resumes it there instead of where it lives.
 */
function sessionState(directory: string): AcpSessionState {
  return createAcpSessionState({
    id: 'session-a',
    title: 'Session A',
    directory,
  } satisfies BackendSessionInfo);
}

describe('the real ACP history loader lets the caller directory override the session own directory', () => {
  it('sends the ambient directory as cwd, overriding the session own /original-project', async () => {
    const sessions = new Map<string, AcpSessionState>([['session-a', sessionState('/original-project')]]);
    const requests: Array<{ method: string; params: unknown }> = [];

    await loadAcpSessionHistory({
      sessionId: 'session-a',
      directory: '/other-project',
      sessions,
      loadedSessions: new Set<string>(),
      supports: (method) => method === 'session/load',
      request: async (method, params) => {
        requests.push({ method, params });
        return { sessionId: 'session-a', configOptions: [] };
      },
    });

    expect(requests).toHaveLength(1);
    const load = requests[0];
    expect(load?.method).toBe('session/load');
    // The observed override: the session's OWN /original-project is discarded.
    expect((load?.params as { cwd?: string } | undefined)?.cwd).toBe('/other-project');
  });

  it('keeps the session own directory when no caller directory is supplied', async () => {
    const sessions = new Map<string, AcpSessionState>([['session-a', sessionState('/original-project')]]);
    const requests: Array<{ method: string; params: unknown }> = [];

    await loadAcpSessionHistory({
      sessionId: 'session-a',
      sessions,
      loadedSessions: new Set<string>(),
      supports: (method) => method === 'session/resume',
      request: async (method, params) => {
        requests.push({ method, params });
        return { sessionId: 'session-a', configOptions: [] };
      },
    });

    expect(requests).toHaveLength(1);
    const resume = requests[0];
    expect(resume?.method).toBe('session/resume');
    expect((resume?.params as { cwd?: string } | undefined)?.cwd).toBe('/original-project');
  });

  it('still lets a caller directory that MATCHES the session own through unchanged', async () => {
    // The ambient directory is legitimate for a genuinely ambient read: passing the
    // session's own directory must not be broken by the fix that stops a mismatch.
    const sessions = new Map<string, AcpSessionState>([['session-a', sessionState('/original-project')]]);
    const requests: Array<{ method: string; params: unknown }> = [];

    await loadAcpSessionHistory({
      sessionId: 'session-a',
      directory: '/original-project',
      sessions,
      loadedSessions: new Set<string>(),
      supports: (method) => method === 'session/load',
      request: async (method, params) => {
        requests.push({ method, params });
        return { sessionId: 'session-a', configOptions: [] };
      },
    });

    expect(requests).toHaveLength(1);
    expect((requests[0]?.params as { cwd?: string } | undefined)?.cwd).toBe('/original-project');
  });

  it('does not re-request a session it has already loaded', async () => {
    const sessions = new Map<string, AcpSessionState>([['session-a', sessionState('/original-project')]]);
    const request = vi.fn(async () => ({ sessionId: 'session-a', configOptions: [] }));

    await loadAcpSessionHistory({
      sessionId: 'session-a',
      directory: '/other-project',
      sessions,
      loadedSessions: new Set<string>(['session-a']),
      supports: (method) => method === 'session/load',
      request,
    });

    expect(request).not.toHaveBeenCalled();
  });
});
