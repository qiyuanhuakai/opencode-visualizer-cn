import type { ImportBatch, ImportBinding, ImportChunk } from './importService.js';
export type ImportAdmission = Readonly<{ importId: string; environmentId: string; sourceRevision: string; offset: number; nextOffset: number; total: number;
  previousHash: string; entries: readonly Readonly<{ key: string; bytes: number; digest: string }>[] }>;
export type ImportContinuation = Readonly<{ sourceKey: string; offset: number; authority: string; binding: ImportBinding }> | null;
export class ImportError extends Error { readonly code: string; constructor(code: string); }
export function digest(value: string): string;
export function exact(value: unknown, keys: readonly string[]): boolean;
export function hashValue(value: unknown): boolean;
export function nonnegative(value: unknown): boolean;
export function bindingValue(binding: ImportBinding): string[];
export function chunkKey(importId: string, chunk: ImportChunk): string;
export function admissionKey(importId: string, offset: number): string;
export function admissionSeed(importId: string, sourceRevision: string, environmentId: string, total: number): string;
export function validateChunk(chunk: unknown, environmentId: string): asserts chunk is ImportChunk;
export function chunkDigest(chunk: ImportChunk): string;
export function continueChunk(continuation: ImportContinuation, chunk: ImportChunk): ImportContinuation;
export function admissionDigest(admission: ImportAdmission): string;
export function validateAdmission(admission: unknown): asserts admission is ImportAdmission;
export function validateBatch(batch: ImportBatch, environmentId: string): void;

export function readImportValue(store: import('../storage/runtimeStore.js').RuntimeStore, item: import('../storage/runtimeStore.js').Item): Promise<import('../storage/runtimeStore.js').Json>;
