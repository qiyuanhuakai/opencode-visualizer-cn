import type { DesktopComponent, DesktopUpdateState } from '../app/types/desktop';

export declare function transition(phase: DesktopUpdateState['phase']): {
  phase: DesktopUpdateState['phase'];
  progress: null;
  error: null;
};
export declare function versionFromInfo(info: unknown): string | null;
export declare function assetNameFromInfo(info: unknown): string | null;
export declare function boundedPercent(progress: unknown): number;
export declare function errorMessage(error: unknown): string;
export declare function unsupportedMessage(component: DesktopComponent): string;
export declare function initialState(
  component: DesktopComponent,
  currentVersion: string | null,
  installKind: DesktopUpdateState['installKind'],
): DesktopUpdateState;
export declare function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void>;
