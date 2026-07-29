export type CodexPlanEntry = {
  threadId: string;
  turnId: string;
  explanation?: string;
  plan: Array<{ step: string; status: string }>;
};

export type CodexPlanTodoSession = {
  sessionId: string;
  title: string;
  description?: string;
  isSubagent: false;
  todos: Array<{ content: string; status: string; priority: 'medium' }>;
  loading: false;
  error: undefined;
};

function todoStatus(status: string) {
  if (status === 'inProgress') return 'in_progress';
  if (status === 'completed') return 'completed';
  return 'pending';
}

export function codexPlansToTodoSessions(
  plans: CodexPlanEntry[],
  allowedSessionIds: ReadonlySet<string>,
  selectedSessionId: string,
  titlesBySessionId: ReadonlyMap<string, string>,
) {
  const latestByThread = new Map<string, CodexPlanEntry>();
  for (const plan of plans) {
    if (allowedSessionIds.has(plan.threadId)) latestByThread.set(plan.threadId, plan);
  }
  const sessions: CodexPlanTodoSession[] = [];
  for (const [sessionId, plan] of latestByThread) {
    if (plan.plan.length === 0) continue;
    sessions.push({
      sessionId,
      title: titlesBySessionId.get(sessionId) ?? sessionId,
      description: plan.explanation,
      isSubagent: false,
      todos: plan.plan.map((item) => ({
        content: item.step,
        status: todoStatus(item.status),
        priority: 'medium',
      })),
      loading: false,
      error: undefined,
    });
  }
  sessions.sort((left, right) => {
    if (left.sessionId === selectedSessionId) return -1;
    if (right.sessionId === selectedSessionId) return 1;
    return left.title.localeCompare(right.title);
  });
  return sessions;
}
