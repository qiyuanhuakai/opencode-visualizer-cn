import type { RelayBinding } from './relayHandshake.js';
import type { RelayChannel } from './computeRelay.js';

export const STEP_MODES: readonly string[];
export const RESERVE_CPUS: number;
export const RESERVE_MEMORY_MIB: number;
export const RELAY_STEP_CPUS: number;
export const RELAY_STEP_MEMORY_MIB: number;
export const STEP_CAPABILITIES: {
  readonly exact: true;
  readonly exclusive: true;
  readonly gresNone: true;
  readonly reserve: true;
};

export interface SlurmComputeBudget {
  readonly cpus: number;
  readonly memoryMiB: number;
}

export interface SlurmAllocationResources {
  readonly partition: string;
  readonly account: string | null;
  readonly cpus: number;
  readonly memory: string;
  readonly time: string;
  readonly gres: string;
  readonly nodes: number;
  readonly ntasks: number;
}

export function buildAllocationResources(options: {
  compute: SlurmComputeBudget;
  partition: string;
  account?: string | null;
  time: string;
  gres: string;
}): SlurmAllocationResources;

export function buildStepArgv(options: {
  mode: string;
  bridgeNode: string;
  jobId: string | number;
  stepId: string;
  compute?: SlurmComputeBudget;
  gres?: string;
  program?: string;
  args?: readonly string[];
}): readonly string[];

export function assertStepCapabilities(input: {
  exact?: boolean;
  exclusive?: boolean;
  gresNone?: boolean;
  reserve?: boolean;
}): typeof STEP_CAPABILITIES;

export interface SlurmStepDescriptor {
  readonly stepId: string;
  readonly intentId?: string;
  readonly jobId?: string | number;
  readonly epoch?: number;
}

export function planStepReplacement(options: {
  current?: SlurmStepDescriptor | null;
  candidate: SlurmStepDescriptor;
}): { readonly action: 'start' | 'replace'; readonly stop?: string; readonly start?: string; readonly epoch?: number | null };

export interface SlurmStepSpec {
  readonly mode: string;
  readonly bridgeNode: string;
  readonly jobId: string | number;
  readonly stepId: string;
  readonly compute: SlurmComputeBudget;
  readonly gres: string;
  readonly intentId?: string;
  readonly epoch?: number;
  readonly program?: string;
  readonly args?: readonly string[];
  readonly capabilities?: Record<string, boolean>;
}

export interface SlurmStepConnection {
  readonly ready: boolean;
  readonly state: string;
  readonly target: { readonly kind: 'compute'; readonly node: string; readonly environmentId?: unknown };
  readonly binding: RelayBinding;
  readonly channel: RelayChannel;
  readonly argv: readonly string[];
  readonly stepId: string;
  replaceOwnedStep(nextStep?: Partial<SlurmStepSpec>): Promise<SlurmStepConnection>;
  close(): Promise<void>;
}

export interface SlurmStepTransport {
  state(): string;
  ownedIds(): readonly string[];
  stderrLog(): string;
  open(input: { step: SlurmStepSpec; binding?: RelayBinding | Record<string, unknown> }): Promise<SlurmStepConnection>;
  replaceOwnedStep(nextStep?: Partial<SlurmStepSpec>): Promise<SlurmStepConnection>;
  close(): Promise<void>;
}

export function createSlurmStepTransport(options?: {
  relay?: unknown;
  spawn?: (command: string, args: readonly string[]) => unknown;
  stopProcessTree?: (child: unknown, options?: unknown) => unknown;
  binding?: RelayBinding | Record<string, unknown>;
  credential?: string;
  loginHosts?: readonly string[];
  store?: unknown;
  srunProgram?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  redactions?: readonly string[];
  timeoutMs?: number;
  uuid?: () => string;
}): SlurmStepTransport;
