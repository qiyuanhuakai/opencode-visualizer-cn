export type KimiWebGoal = {
  readonly goalId: string;
  readonly objective: string;
  readonly status: 'active' | 'paused' | 'blocked' | 'complete';
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly completionCriterion?: string;
  readonly terminalReason?: string;
};

export type KimiWebGoalChange =
  | { readonly goal_objective: string }
  | { readonly goal_control: 'pause' | 'resume' | 'cancel' };

export function parseKimiWebGoal(value: unknown): KimiWebGoal | null {
  if (value === null) return null;
  if (
    typeof value !== 'object' ||
    !('goalId' in value) ||
    typeof value.goalId !== 'string' ||
    !('objective' in value) ||
    typeof value.objective !== 'string' ||
    !('status' in value) ||
    (value.status !== 'active' &&
      value.status !== 'paused' &&
      value.status !== 'blocked' &&
      value.status !== 'complete') ||
    !('turnsUsed' in value) ||
    typeof value.turnsUsed !== 'number' ||
    !('tokensUsed' in value) ||
    typeof value.tokensUsed !== 'number' ||
    !('wallClockMs' in value) ||
    typeof value.wallClockMs !== 'number'
  )
    throw new TypeError('Invalid Kimi Web goal response');
  return {
    goalId: value.goalId,
    objective: value.objective,
    status: value.status,
    turnsUsed: value.turnsUsed,
    tokensUsed: value.tokensUsed,
    wallClockMs: value.wallClockMs,
    completionCriterion:
      'completionCriterion' in value && typeof value.completionCriterion === 'string'
        ? value.completionCriterion
        : undefined,
    terminalReason:
      'terminalReason' in value && typeof value.terminalReason === 'string'
        ? value.terminalReason
        : undefined,
  };
}
