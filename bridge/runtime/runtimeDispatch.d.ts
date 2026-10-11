import type { Binding, Hello, Request, Result } from '../../shared/runtime/protocol.js';
import type { TargetGrant } from '../../shared/runtime/runtimeWire.js';
import type { RuntimeServices } from './runtimeServices.js';
import type { RuntimeInspection } from './runtimeHost.js';
export interface RuntimeTransport {
  send(frame: Result): void;
  sendBinary(bytes: Uint8Array): void;
  canSend(bytes: number): boolean;
}
export interface RuntimeDispatch {
  hello(): Hello;
  binary(bytes: Uint8Array): void;
  request(frame: Request): Promise<void>;
  close(): Promise<void>;
}
export function createRuntimeDispatch(options: RuntimeTransport & {
  readonly management: RuntimeServices; readonly targets?: readonly RuntimeServices[];
  readonly grants?: readonly TargetGrant[]; readonly binding: Binding;
  readonly assertCurrent: () => void; readonly inspect: () => RuntimeInspection;
}): RuntimeDispatch;
