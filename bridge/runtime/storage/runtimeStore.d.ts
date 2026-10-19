export type Collection = 'environments' | 'harnesses' | 'workspaces' | 'session_summaries' | 'threads' | 'participants' | 'turns' | 'teams' | 'tasks' | 'attempts' | 'interactions' | 'artifacts' | 'checkpoints' | 'operations' | 'imports' | 'tombstones';
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export interface StoreOptions {
  readonly stateDirectory: string; readonly environmentId: string; readonly ownerId: string; readonly epoch: string;
  /** Trusted local control plane only: atomically replaces the explicitly observed owner fence. Never expose as an unauthenticated RPC parameter. */
  readonly takeover?: { readonly expectedFence: number };
  readonly installRoot?: string; readonly requestTimeoutMs?: number; readonly storageBudgetBytes?: number;
}
export interface Change { readonly collection: Collection; readonly key: string; readonly value: Json; readonly expectedRevision?: number }
export interface Mutation { readonly intentId: string; readonly changes: readonly Change[] }
export interface Ack { readonly phase: 'durable-accepted'; readonly intentId: string; readonly revision: number; readonly watermark: number }
export interface Item { readonly key: string; readonly revision: number; readonly value?: Json; readonly chunked?: boolean; readonly bytes?: number }
export interface PageOptions { readonly collection: Collection; readonly cursor?: string | null; readonly limit?: number; readonly token?: string }
export interface Page { readonly items: readonly Item[]; readonly cursor: string | null }
export interface Snapshot extends Page { readonly token: string; readonly epoch: string; readonly revision: number; readonly watermark: number; readonly expiresAt: number }
export interface Inspection { readonly fence: number; readonly epoch: string; readonly revision: number; readonly seq: number; readonly floor: number; readonly pid: number; readonly backupPath: string | null; readonly locality: { readonly local: boolean; readonly platform: string; readonly type: string; readonly canonicalPath: string } }
export interface Exit { readonly code: number | null; readonly signal: string | null; readonly pid: number }
export interface RuntimeStore {
  readonly ready: Promise<Inspection>; readonly pid: number; readonly queue: { readonly normal: number; readonly control: number; readonly bytes: number };
  mutate(params: Mutation): Promise<Ack>;
  mutateControl(params: Mutation): Promise<Ack>;
  readIntent(params: { readonly intentId: string }): Promise<Ack | null>;
  get(params: { readonly collection: Collection; readonly key: string }): Promise<Item | null>;
  page(params: PageOptions): Promise<Page>;
  snapshot(params: PageOptions): Promise<Snapshot>;
  readChunk(params: { readonly collection: Collection; readonly key: string; readonly revision: number; readonly offset: number; readonly token?: string }): Promise<{ readonly revision: number; readonly bytes: number; readonly offset: number; readonly data: string; readonly nextOffset: number | null }>;
  replay(params: { readonly epoch: string; readonly after: number; readonly limit?: number }): Promise<{ readonly epoch: string; readonly events: readonly Json[]; readonly through: number; readonly watermark: number }>;
  inspect(): Promise<Inspection>; close(): Promise<Exit>; terminate(): Promise<Exit>;
}
export function createRuntimeStore(options: StoreOptions): RuntimeStore;
export function resolveStoreWorker(installRoot?: string): { readonly workerPath: string; readonly execPath: string };
