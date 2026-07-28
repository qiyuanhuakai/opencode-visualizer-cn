import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendSelectionBootstrap } from './useBackendSelectionBootstrap';

describe('useBackendSelectionBootstrap', () => {
  it('selects Codex active session through backend-neutral bootstrap runtime', async () => {
    const selectedProjectId = ref('');
    const selectedSessionId = ref('');
    const runtime = useBackendSelectionBootstrap({
      activeBackendKind: ref('codex'),
      codexProjectId: 'codex',
      selectedProjectId,
      selectedSessionId,
      codexActiveSessionId: ref('thread-1'),
      initialProjectId: () => '',
      initialSessionId: () => '',
      sessionExistsInProjects: () => false,
      switchSessionSelection: vi.fn(),
      initializeSessionSelection: vi.fn(),
    });

    await runtime.bootstrapSelection();

    expect(selectedProjectId.value).toBe('codex');
    expect(selectedSessionId.value).toBe('thread-1');
  });

  it('restores explicit OpenCode initial session when it exists', async () => {
    const switchSessionSelection = vi.fn().mockResolvedValue(undefined);
    const initializeSessionSelection = vi.fn();
    const runtime = useBackendSelectionBootstrap({
      activeBackendKind: ref('opencode'),
      codexProjectId: 'codex',
      selectedProjectId: ref(''),
      selectedSessionId: ref(''),
      codexActiveSessionId: ref(''),
      initialProjectId: () => 'proj-1',
      initialSessionId: () => 'session-1',
      sessionExistsInProjects: () => true,
      switchSessionSelection,
      initializeSessionSelection,
    });

    await runtime.bootstrapSelection();

    expect(switchSessionSelection).toHaveBeenCalledWith('proj-1', 'session-1');
    expect(initializeSessionSelection).not.toHaveBeenCalled();
  });

  it('delegates OpenCode selection to the dedicated bootstrap when provided', async () => {
    const bootstrapOpenCodeSelection = vi.fn().mockResolvedValue(undefined);
    const switchSessionSelection = vi.fn();
    const initializeSessionSelection = vi.fn();
    const runtime = useBackendSelectionBootstrap({
      activeBackendKind: ref('opencode'),
      codexProjectId: 'codex',
      selectedProjectId: ref(''),
      selectedSessionId: ref(''),
      codexActiveSessionId: ref(''),
      initialProjectId: () => 'proj-1',
      initialSessionId: () => 'session-1',
      sessionExistsInProjects: () => true,
      switchSessionSelection,
      initializeSessionSelection,
      bootstrapOpenCodeSelection,
    });

    await runtime.bootstrapSelection();

    expect(bootstrapOpenCodeSelection).toHaveBeenCalledTimes(1);
    expect(switchSessionSelection).not.toHaveBeenCalled();
    expect(initializeSessionSelection).not.toHaveBeenCalled();
  });

  it('never calls the OpenCode bootstrap on the Codex backend', async () => {
    const bootstrapOpenCodeSelection = vi.fn();
    const selectedProjectId = ref('');
    const selectedSessionId = ref('');
    const runtime = useBackendSelectionBootstrap({
      activeBackendKind: ref('codex'),
      codexProjectId: 'codex',
      selectedProjectId,
      selectedSessionId,
      codexActiveSessionId: ref('thread-1'),
      initialProjectId: () => '',
      initialSessionId: () => '',
      sessionExistsInProjects: () => false,
      switchSessionSelection: vi.fn(),
      initializeSessionSelection: vi.fn(),
      bootstrapOpenCodeSelection,
    });

    await runtime.bootstrapSelection();

    expect(bootstrapOpenCodeSelection).not.toHaveBeenCalled();
    expect(selectedProjectId.value).toBe('codex');
    expect(selectedSessionId.value).toBe('thread-1');
  });
});
