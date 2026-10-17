import type { SlurmControlStore, SlurmIntentRecord } from './slurmControlStore.js';

export const SLURM_HANDSHAKE_KIND: string;
export const JOB_STATE_FIELDS: readonly string[];

export function parseSlurmTime(value: string): number;
export function parseSlurmMemory(value: string): number;

export interface SlurmResourceInput {
  readonly partition: string;
  readonly account?: string | null;
  readonly cpus: number;
  readonly memory: string | number;
  readonly time: string;
  readonly gres: string;
}

export interface SlurmResources {
  readonly account: string | null;
  readonly partition: string;
  readonly cpus: number;
  readonly memory: string;
  readonly memoryMiB: number;
  readonly time: string;
  readonly timeSeconds: number;
  readonly gres: string;
  readonly gpus: boolean;
  readonly nodes: number;
  readonly ntasks: number;
}

export interface SlurmResourcePreview {
  readonly nodes: number;
  readonly ntasks: number;
  readonly cpus: number;
  readonly memory: string;
  readonly memoryMiB: number;
  readonly time: string;
  readonly timeSeconds: number;
  readonly gres: string;
  readonly requestsGpu: boolean;
  readonly partition: string;
  readonly account: string | null;
}

export function normalizeSlurmResources(input: unknown): SlurmResources;
export function buildResourcePreview(resources: unknown): SlurmResourcePreview;

export function buildSbatchScript(options: {
  intentId: string;
  resources: unknown;
  command: string;
  args?: readonly string[];
  cwd?: string | null;
  env?: Record<string, string>;
  output?: string;
}): string;

export function buildSbatchArgv(options: { intentId: string; resources?: unknown }): readonly string[];

export function parseSbatchOutput(stdout: string | undefined): { jobId: string; cluster: string | null };

export interface SlurmSqueueJob {
  readonly jobId: string;
  readonly name: string;
  readonly state: string;
  readonly comment: string;
  readonly partition: string;
  readonly nodes: string;
}
export function parseSqueueOutput(text: string | undefined): readonly SlurmSqueueJob[];

export interface SlurmScontrolJob {
  readonly jobId: string | null;
  readonly name: string | null;
  readonly comment: string | null;
  readonly jobState: string | null;
  readonly partition: string | null;
  readonly nodeList: string | null;
  readonly exitCode: string | null;
}
export function parseScontrolShowJob(text: string | undefined): SlurmScontrolJob;

export interface SlurmQueueState {
  readonly queue: string;
  readonly terminal: string | null;
  readonly requeued: boolean;
}
export function mapQueueState(raw: unknown): SlurmQueueState;

export interface SlurmHandshakeChallenge {
  readonly kind: string;
  readonly credentialProtected: boolean;
  readonly intentId: string;
  readonly nonce: string;
  readonly token: string;
}
export interface SlurmHandshake {
  readonly kind: string;
  readonly credentialProtected: boolean;
  challenge(intentId: string): SlurmHandshakeChallenge;
  verify(response: unknown): boolean;
}
export function createSlurmHandshake(options: { credential: string }): SlurmHandshake;

export interface SlurmSchedulerMatch {
  readonly jobId: string;
  readonly name?: string;
  readonly state?: string;
  readonly comment?: string;
  readonly partition?: string;
  readonly nodes?: string;
}
export interface SlurmScheduler {
  submit(request: { intentId: string; script: string; argv: readonly string[]; resources?: unknown; ownership?: string }): Promise<unknown>;
  query(request: { intentId: string; uuid: string }): Promise<{ matches?: readonly SlurmSchedulerMatch[] } | undefined>;
  cancel(request: { intentId: string; jobId: string }): Promise<unknown>;
}

export interface SlurmSubmitRequest {
  readonly resources: unknown;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly output?: string;
  readonly sharedRoot?: string;
  readonly computeWorkingRoot?: string;
  readonly ownership?: 'owned' | 'borrowed';
}
export interface SlurmSubmitResult {
  readonly intentId: string;
  readonly state: string;
  readonly reconcile: string | null;
  readonly jobId: string | null;
  readonly ownership: string;
  readonly preview: SlurmResourcePreview;
  readonly intent: SlurmIntentRecord;
}
export interface SlurmDetachResult {
  readonly intentId: string;
  readonly attached: boolean;
  readonly cancelled: boolean;
  readonly signalled: boolean;
}
export interface SlurmStopResult {
  readonly intentId: string;
  readonly signalled: boolean;
  readonly cancelled: boolean;
  readonly reason?: string;
  readonly jobId: string | null;
}

export interface SlurmJobController {
  readonly environmentId: string;
  submit(request: SlurmSubmitRequest): Promise<SlurmSubmitResult>;
  reconcile(intentId: string): Promise<SlurmIntentRecord>;
  state(intentId: string): Promise<SlurmIntentRecord | undefined>;
  detach(intentId: string): Promise<SlurmDetachResult>;
  stop(intentId: string): Promise<SlurmStopResult>;
  preview(resources: unknown): SlurmResourcePreview;
  close(): Promise<unknown>;
}

export function createSlurmJobController(options: {
  store: SlurmControlStore;
  scheduler: SlurmScheduler;
  environmentId: string;
  clock?: () => number;
  uuid?: () => string;
}): SlurmJobController;
