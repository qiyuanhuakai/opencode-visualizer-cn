export function createFixture(context: { readonly temporaryRoot: string; readonly runDir: string; readonly evidenceDir: string; readonly case: string }): Promise<{
  readonly root: string;
  readonly resources: readonly unknown[];
  register(entry: Record<string, unknown>): void;
  own(kind: string, close: () => Promise<unknown>): void;
  close(): Promise<unknown>;
  persist(): void;
}>;
