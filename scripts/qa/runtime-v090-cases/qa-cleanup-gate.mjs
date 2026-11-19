// A QA case that fails to release an owned resource must not report success.
// The cases used to swallow `fixture.close()` failures into the cleanup receipt,
// so a port rebind, a surviving PID or a temp-directory removal failure still
// produced `status: passed` evidence while the resource leaked. The receipt is
// written FIRST — the ledger has to record what happened — and only then does
// the failure fail the case. A failure already in flight is kept as the cause
// so neither the original failure nor the cleanup failure is lost.
export function cleanupFailure(closed, cause) {
  if (closed === null || typeof closed !== 'object' || typeof closed.error !== 'string') return null;
  return new Error(`QA cleanup failed: ${closed.error}`, cause instanceof Error ? { cause } : undefined);
}
