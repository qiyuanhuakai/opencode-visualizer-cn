import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { ProjectState } from '../types/worker-state';
import { useSessionSelection } from './useSessionSelection';

function setup() {
  const projects = ref<Record<string, ProjectState>>({
    p: { id: 'p', worktree: '/repo', sandboxes: {
      '/repo': { directory: '/repo', name: 'main', rootSessions: ['current'], sessions: {
        current: { id: 'current' },
      } },
    } },
  });
  const gate = Promise.withResolvers<void>();
  const create = vi.fn(async (projectId: string) => ({ id: 'created', projectId }));
  const selection = useSessionSelection(projects, create, undefined, {
    ensureDirectoryHydrated: () => gate.promise,
  });
  return { projects, gate, create, selection };
}

describe('latest session selection intent', () => {
  it('keeps the newer selection when an older directory hydration completes', async () => {
    const { projects, gate, selection } = setup();
    const pending = selection.ensureDirectorySession('p', '/late');
    await selection.switchSession('p', 'current');
    const project = projects.value.p;
    if (!project) throw new Error('missing fixture project');
    project.sandboxes['/late'] = { directory: '/late', name: 'late', rootSessions: ['late'], sessions: {
      late: { id: 'late' },
    } };
    gate.resolve();
    await pending;
    expect(selection.selectedSessionId.value).toBe('current');
  });

  it('does not create a session for an abandoned loaded-empty directory', async () => {
    const { gate, selection, create } = setup();
    const pending = selection.ensureDirectorySession('p', '/late');
    await selection.switchSession('p', 'current');
    gate.resolve();
    await pending;
    expect(create).not.toHaveBeenCalled();
    expect(selection.selectedSessionId.value).toBe('current');
  });

  it('does not overwrite the latest selection when an earlier switch finishes waiting', async () => {
    const { projects, selection } = setup();
    const pending = selection.switchSession('p', 'late');
    await selection.switchSession('p', 'current');
    const sandbox = projects.value.p?.sandboxes['/repo'];
    if (!sandbox) throw new Error('missing fixture sandbox');
    sandbox.sessions.late = { id: 'late' };
    sandbox.rootSessions.push('late');
    await pending;
    expect(selection.selectedSessionId.value).toBe('current');
  });
});
