export const SLURM_HOST_ROLES: readonly string[];
export const SLURM_LOGIN_PROGRAMS: readonly string[];
export const SLURM_COMPUTE_PROGRAMS: readonly string[];
export const COMPUTE_DELIVERY_CHANNELS: readonly string[];

export interface SlurmHostProbeInput {
  readonly role: string;
  readonly platform: string;
  readonly programs?: Record<string, boolean>;
  readonly bridgeInstalled?: boolean;
  readonly bridgeVersion?: string | null;
  readonly controlRoot?: string | null;
  readonly workspaceRoot?: string | null;
  readonly nativeDataRoot?: string | null;
}

export interface SlurmHostProbe {
  readonly role: string;
  readonly platform: string;
  readonly programs: Readonly<Record<string, boolean>>;
  readonly programsReady: boolean;
  readonly bridgeInstalled: boolean;
  readonly bridgeVersion: string | null;
  readonly controlRoot: string | null;
  readonly workspaceRoot: string | null;
  readonly nativeDataRoot: string | null;
}

export function parseSlurmHostProbe(input: SlurmHostProbeInput): SlurmHostProbe;

export function assertIndependentRoots(options: {
  controlRoot?: string | null;
  workspaceRoot?: string | null;
  nativeDataRoot?: string | null;
}): { readonly independent: boolean; readonly controlRoot: string | null; readonly workspaceRoot: string; readonly nativeDataRoot: string | null };

export interface ComputeDelivery {
  readonly channel: 'slurm-shared-root' | 'slurm-controlled-channel';
  readonly shared: boolean;
  readonly requiresExplicitAction: boolean;
}
export function planComputeDelivery(options: { sharedRootAvailable?: boolean }): ComputeDelivery;

export interface SlurmBootstrapPlan {
  readonly environmentId: string;
  readonly controlHost: 'login';
  readonly executionHost: 'compute';
  readonly submitControlHost: 'login';
  readonly agentExecutionHost: 'compute';
  readonly loginControlRoot: string | null;
  readonly computeWorkspaceRoot: string | null;
  readonly computeWorkingRoot: string | null;
  readonly computeNativeDataRoot: string | null;
  readonly login: SlurmHostProbe;
  readonly compute: SlurmHostProbe;
  readonly delivery: ComputeDelivery;
  readonly automatic: false;
  readonly requiresExplicitAction: boolean;
  readonly sharedRootAvailable: boolean;
}

export function planSlurmBootstrap(options: {
  profile?: unknown;
  environmentId?: string;
  login: SlurmHostProbeInput;
  compute: SlurmHostProbeInput;
  sharedRootAvailable?: boolean;
}): SlurmBootstrapPlan;
