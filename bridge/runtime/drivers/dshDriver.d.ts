import type { HarnessRegistration } from '../../../shared/runtime/harnessContract.js';
import type { JsonValue } from '../../../shared/runtime/capabilities.js';
import type { RuntimeStore } from '../storage/runtimeStore.js';
import type { TransportOptions } from './dshTransport.js';
export interface DshDriverOptions extends TransportOptions {
  readonly environmentId: string; readonly harnessInstanceId: string; readonly epoch: string; readonly store: RuntimeStore;
  readonly onEvent?: (event: JsonValue) => void; readonly now?: () => number;
}
export function createDshDriver(options: DshDriverOptions): HarnessRegistration & { close(): Promise<void> };
