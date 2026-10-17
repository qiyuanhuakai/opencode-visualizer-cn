export type KnownHostEntry = {
  readonly markers: readonly string[];
  readonly patterns: readonly string[];
  readonly keyType: string;
  readonly keyBlob: string;
  readonly comment: string;
};
export type HostKeyStatus = 'trusted' | 'unknown' | 'changed' | 'revoked';
export type HostKeyEvaluation = {
  readonly status: HostKeyStatus;
  readonly fingerprint: string;
  readonly entry?: KnownHostEntry;
};
export type KnownHostInput = {
  readonly host: string;
  readonly port?: number;
  readonly keyType: string;
  readonly keyBlob: string;
};
export type KnownHostEntryInput = {
  readonly host: string;
  readonly port?: number;
  readonly keyType: string;
  readonly keyBlob: string;
  readonly marker?: string;
};
export const KNOWN_HOST_MARKERS: readonly string[];
export function hostPortKey(host: string, port?: number): string;
export function keyFingerprint(keyBlob: string): string;
export function parseKnownHosts(text: string | undefined | null): readonly KnownHostEntry[];
export function evaluateHostKey(entries: readonly KnownHostEntry[], input: KnownHostInput): HostKeyEvaluation;
export function formatKnownHostEntry(input: KnownHostEntryInput): string;
export function appendKnownHost(text: string | undefined, entry: KnownHostEntryInput): string;
