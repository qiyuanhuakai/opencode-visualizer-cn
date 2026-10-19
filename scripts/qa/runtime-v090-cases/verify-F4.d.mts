// TypeScript declarations for the F4 final-verifier registration.
//
// The module is plain ESM JavaScript executed by the QA runner; it is
// intentionally NOT type-checked. These declarations exist so the isolation
// tests under app/** can drive the REAL eight-row join against an evidence tree
// placed at an arbitrary path, with a decoy tree inside the checkout, without
// `@ts-ignore`, `as any` or an implicit `any` anywhere.

/** The runner context a lane receives. */
export interface VerifierContext {
  verify?: string;
  task?: number;
  case?: string;
  out: string;
  evidenceRoot?: string;
  ledgerWorktrees?: string;
  root: string;
  /** Runner-derived; a lane that is driven directly (as the isolation tests do) need not supply it. */
  outDir?: string;
  temporaryRoot?: string;
}

/** One cited proof inside the eight-row join. */
export interface F4Proof {
  path: string;
  present: boolean;
  proof: boolean;
  kind: 'directory' | 'manifest' | null;
  status?: string | null;
  sha256?: string | null;
  bytes?: number | null;
  origin?: string | null;
}

/** One IS row of the join. */
export interface F4JoinRow {
  is: string;
  complete: boolean;
  proofs: F4Proof[];
}

/** The resolved audit inputs, carried in the report so a bound manifest proves
 *  WHICH evidence tree this lane audited. */
export interface F4ResolvedInputs {
  root: string;
  evidenceRoot: string;
  ledgerWorktrees: string | null;
  detailDir: string;
}

/** What the F4 lane reports. */
export interface F4Report {
  scenario: string;
  lane: 'happy' | 'failure';
  checkerVerdict: string;
  fidelityVerdict?: unknown;
  perIsEvaluation?: unknown;
  mutationCount?: number;
  scenarios: { name: string; surface?: string; assertions: { name: string; passed: boolean; observed: unknown; expected: unknown }[] }[];
  artifacts: unknown[];
  resolvedInputs: F4ResolvedInputs;
  versions: Record<string, string>;
}

/** The registered source files this lane hashes. */
export declare const sourceFiles: readonly string[];

export declare function run(context: VerifierContext): Promise<F4Report>;
