import { ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import { getActiveBackendAdapter } from '../backends/registry';

export type TodoItem = {
  content: string;
  status: string;
  priority: string;
};

export function useTodos(options: {
  selectedSessionId: Ref<string>;
  allowedSessionIds: ComputedRef<Set<string>>;
  activeDirectory: Ref<string>;
}) {
  const todosBySessionId = ref<Record<string, TodoItem[]>>({});
  const todoLoadingBySessionId = ref<Record<string, boolean>>({});
  const todoErrorBySessionId = ref<Record<string, string>>({});
  let todoReloadRequestId = 0;

  function normalizeTodoItem(value: unknown): TodoItem | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    const status = typeof record.status === 'string' ? record.status.trim() : '';
    const priority = typeof record.priority === 'string' ? record.priority.trim() : '';
    if (!content) return null;
    return { content, status: status || 'pending', priority: priority || 'medium' };
  }

  function normalizeTodoItems(value: unknown) {
    if (!Array.isArray(value)) return [] as TodoItem[];
    return value
      .map((item) => normalizeTodoItem(item))
      .filter((item): item is TodoItem => Boolean(item));
  }

  async function reloadTodosForAllowedSessions() {
    const requestId = ++todoReloadRequestId;
    const sessionId = options.selectedSessionId.value;
    const sessionIds = sessionId ? Array.from(options.allowedSessionIds.value) : [];
    if (sessionIds.length === 0) {
      todosBySessionId.value = {};
      todoLoadingBySessionId.value = {};
      todoErrorBySessionId.value = {};
      return;
    }
    const directory = options.activeDirectory.value.trim() || undefined;
    const loading: Record<string, boolean> = {};
    sessionIds.forEach((id) => {
      loading[id] = true;
    });
    todoLoadingBySessionId.value = loading;
    const nextTodos: Record<string, TodoItem[]> = {};
    const nextErrors: Record<string, string> = {};
    await Promise.all(
      sessionIds.map(async (id) => {
        try {
          const getSessionTodos = getActiveBackendAdapter().getSessionTodos;
          const data = getSessionTodos ? await getSessionTodos(id, directory) : [];
          nextTodos[id] = normalizeTodoItems(data);
        } catch (error) {
          nextTodos[id] = [];
          nextErrors[id] = error instanceof Error ? error.message : String(error);
        }
      }),
    );
    if (requestId !== todoReloadRequestId) return;
    todoLoadingBySessionId.value = {};
    todoErrorBySessionId.value = nextErrors;
    todosBySessionId.value = nextTodos;
  }

  return {
    todosBySessionId,
    todoLoadingBySessionId,
    todoErrorBySessionId,
    normalizeTodoItems,
    reloadTodosForAllowedSessions,
  };
}
