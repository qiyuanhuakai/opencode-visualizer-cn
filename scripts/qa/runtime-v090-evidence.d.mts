export function digest(bytes: string | Uint8Array): string;
export function sourceSnapshot(root: string, files: readonly string[]): Record<string, string>;
export function normalizeVitest(report: unknown, receipt: unknown, context: { readonly root: string; readonly task: number; readonly case: string; readonly raw: string }): { readonly scenarios: readonly unknown[] };
export function validateEvidence(value: unknown, root: string): unknown;

export function artifact(file: string, kind: string): { readonly path: string; readonly kind: string; readonly sha256: string };
