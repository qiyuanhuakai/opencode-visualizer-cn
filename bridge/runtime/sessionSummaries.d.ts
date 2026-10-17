import type { HarnessKind } from '../../shared/runtime/harnessContract.js';
import type { EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';
export interface SourceIdentity { readonly kind: HarnessKind; readonly environmentId: EnvironmentId; readonly harnessInstanceId: HarnessInstanceId }
export interface SourceAuthority { readonly epoch: string; readonly processGeneration: number }
export interface SessionSummary {
  readonly session: SessionRef;
  readonly title: string;
  readonly directory: string | null;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly parentSession: SessionRef | null;
  readonly createdAt: string | number | null;
  readonly updatedAt: string | number | null;
  readonly nativeWorkspaceId: string | null;
  readonly nativeProjectId: string | null;
  readonly status: string | null;
  readonly modelProvider: string | null;
  readonly agentNickname: string | null;
  readonly agentRole: string | null;
  readonly sourceKind: string | null;
}
export interface DiscoveryScope {
  readonly directory?: string;
  readonly archived?: boolean;
  readonly projectID?: string;
  readonly parentID?: string;
  readonly roots?: boolean;
  readonly workspaceId?: string;
}
export interface NativeSummaryPage {
  readonly items: readonly SessionSummary[];
  readonly cursor: string | null;
  readonly completeness: 'complete' | 'partial' | 'unsupported';
  readonly reason: string;
  readonly total?: number;
  readonly authority?: SourceAuthority;
}
export function sourceIdentity(input: { readonly kind: string; readonly environmentId: string; readonly harnessInstanceId: string }): SourceIdentity;
export function sourceAuthority(input: SourceAuthority): SourceAuthority;
export function sameAuthority(left: SourceAuthority, right: SourceAuthority): boolean;
export function sessionSummary(source: SourceIdentity, input: unknown): SessionSummary;
export function discoveryScope(kind: HarnessKind, input?: DiscoveryScope): DiscoveryScope;
export function matchesScope(summary: SessionSummary, scope: DiscoveryScope): boolean;
export function nativePage(source: SourceIdentity, input: unknown): NativeSummaryPage;
