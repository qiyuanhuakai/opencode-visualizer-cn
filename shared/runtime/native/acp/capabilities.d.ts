import { ProtocolError } from '../../capabilities.js';
import type { ErrorCode } from '../../capabilities.js';
import type { EnvironmentId, HarnessInstanceId, InstanceId } from '../../identity.js';
import type { JsonValue } from '../../capabilities.js';
export type AcpObject = { readonly [key: string]: JsonValue };
export interface AcpBinding {
  readonly target: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly epoch: InstanceId;
  readonly processGeneration: number;
}
export class AcpError extends ProtocolError {
  readonly reason: string;
  constructor(code: ErrorCode, reason: string);
}
export interface AcpCapabilities {
  readonly protocolVersion: 1;
  readonly load: boolean;
  readonly resume: boolean;
  readonly list: boolean;
  readonly concurrent: boolean;
  readonly authMethods: readonly AcpObject[];
  readonly native: AcpObject;
  readonly listCompleteness: 'bounded' | 'native';
}
export type AcpQueue = <T>(action: () => Promise<T> | T) => Promise<T>;
export function record(value: unknown): AcpObject;
export function text(value: unknown): string;
export function inspectCapabilities(input: JsonValue): AcpCapabilities;
export function serialQueue(isConcurrent: () => boolean, assertCurrent: () => void): AcpQueue;
