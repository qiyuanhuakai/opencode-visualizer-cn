export function isUnmaterializedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /not materialized/i.test(message) ||
    /includeTurns is unavailable/i.test(message) ||
    /no rollout found/i.test(message)
  );
}
