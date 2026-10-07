import type { HarnessScope, HarnessManifest, HarnessMethod } from '../../harnessContract.js';
export const CODEX_PROFILE: '0.160.0';
export const NATIVE_METHODS: Readonly<
  Record<
    string,
    {
      readonly method: string;
      readonly scope: 'session' | 'instance';
      readonly mutation?: boolean;
      readonly fields: readonly string[];
    }
  >
>;
export const COMMANDS: readonly {
  readonly name: string;
  readonly operation: string;
  readonly ephemeral?: boolean;
}[];
export function codexManifest(
  scope: HarnessScope,
  native: Readonly<Record<string, HarnessMethod>>,
): HarnessManifest;
