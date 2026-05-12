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
});
