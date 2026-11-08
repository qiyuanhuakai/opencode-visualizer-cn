export const ADMISSION_LIMITS: Readonly<{
  connection: 512;
  normal: 256;
  control: 16;
  bytes: 16777216;
  reservedBytes: 1048576;
  deadlineMs: 15000;
}>;
export interface AdmissionQueue {
  readonly pending: {
    readonly normal: number;
    readonly control: number;
    readonly bytes: number;
    readonly total: number;
  };
  run<T>(
    options: { readonly size?: number; readonly reserved?: boolean; readonly deadlineMs?: number },
    action: (signal: AbortSignal, reservePayload: (size: number) => void) => T | Promise<T>,
  ): Promise<T>;
}
export function createAdmissionQueue(options?: {
  readonly connectionOnly?: boolean;
}): AdmissionQueue;
