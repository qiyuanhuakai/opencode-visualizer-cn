// TypeScript declarations for the F1 final-verifier registration.
//
// The module is plain ESM JavaScript executed by the QA runner; it is
// intentionally NOT type-checked. These declarations exist so the isolation
// tests under app/** can drive the REAL lane against a checkout placed at an
// arbitrary path, with a decoy tree beside it, without `@ts-ignore`, `as any`
// or an implicit `any` anywhere.

/** The runner context a lane receives. */
export interface VerifierContext {
  verify?: string;
  task?: number;
  case?: string;
  out: string;
  evidenceRoot?: string;
  planPath?: string;
  ledgerWorktrees?: string;
  finalHead?: string;
  root: string;
  /** Runner-derived; a lane that is driven directly (as the isolation tests do) need not supply it. */
  outDir?: string;
  temporaryRoot?: string;
}

/** One audit finding. */
export interface F1Finding {
  id: string;
  severity: 'blocking' | 'advisory';
  planLine?: number;
  detail: string;
}

/** One negative-control mutation in the failure lane. */
export interface F1Mutation {
  id: string;
  detected: boolean;
}

/** What the F1 lane reports. */
export interface F1Report {
  scenario: string;
  verdict: string;
  findings: F1Finding[];
  mutations: F1Mutation[];
  checks: Record<string, unknown> & {
    planPath: string;
    root: string;
    evidenceRoot: string;
    taskRows: number;
    missingModules: string[];
    uncheckedTasks: number[];
  };
  scenarios: { name: string; assertions: { name: string; passed: boolean; observed: unknown; expected: unknown }[] }[];
  artifacts: unknown[];
  versions: Record<string, string>;
}

export declare function run(context: VerifierContext): Promise<F1Report>;
