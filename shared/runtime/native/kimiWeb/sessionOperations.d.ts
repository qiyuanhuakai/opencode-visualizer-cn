export const KIMI_SESSION_OPERATIONS: Readonly<Record<string, {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly suffix: string;
  readonly query?: readonly string[];
}>>;
