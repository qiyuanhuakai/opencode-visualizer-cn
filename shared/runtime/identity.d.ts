export const IDENTITY_SCHEMA_VERSION: 1;
declare const identityBrand: unique symbol;
type IdentityString<Name extends string> = string & { readonly [identityBrand]: Name };
export type EnvironmentId = IdentityString<'EnvironmentId'>;
export type ConnectionProfileId = IdentityString<'ConnectionProfileId'>;
export type HarnessInstanceId = IdentityString<'HarnessInstanceId'>;
export type InstanceId = IdentityString<'InstanceId'>;
export type SessionKey = IdentityString<'SessionKey'>;
export type WorkspaceKey = IdentityString<'WorkspaceKey'>;
export type RepoKey = IdentityString<'RepoKey'>;
export class IdentityError extends TypeError {
  readonly code: 'invalid_identity' | 'unsupported_identity_version';
  readonly field: string;
  constructor(field: string, code?: 'invalid_identity' | 'unsupported_identity_version');
}
export type SessionRef = {
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly nativeSessionId: string;
};
/** Target-probed volume identity and case policy; never inferred from the client OS. */
export type PathPolicy = {
  readonly platform: 'posix' | 'windows';
  readonly caseSensitive: boolean;
  readonly volumeId: string;
};
/** canonicalPath must already be resolved by the target, including symlinks and case. */
export type WorkspaceRef = {
  readonly environmentId: EnvironmentId;
  readonly canonicalPath: string;
  readonly pathPolicy: PathPolicy;
};
/** canonicalCommonDir is the target's canonical Git common-dir, not a remote URL. */
export type RepoRef = {
  readonly environmentId: EnvironmentId;
  readonly canonicalCommonDir: string;
  readonly pathPolicy: PathPolicy;
};
export type EnvironmentBinding =
  | { readonly kind: 'local' | 'direct' | 'ssh'; readonly environmentId: EnvironmentId }
  | { readonly kind: 'slurm'; readonly clusterEnvironmentId: EnvironmentId };
/** UUID inputs are normalized to lowercase; endpoints and hostnames are rejected. */
export function parseEnvironmentId(value: unknown): EnvironmentId;
export function parseConnectionProfileId(value: unknown): ConnectionProfileId;
export function parseHarnessInstanceId(value: unknown): HarnessInstanceId;
export function parseInstanceId(value: unknown): InstanceId;
export function resolveEnvironmentId(value: unknown): EnvironmentId;
export function parseSessionRef(value: unknown): SessionRef;
export function parseWorkspaceRef(value: unknown): WorkspaceRef;
export function parseRepoRef(value: unknown): RepoRef;
/** base64url(UTF-8 JSON [1,"session",environmentId,harnessInstanceId,nativeSessionId]).
 * Example tuple: [1,"session","11111111-1111-4111-8111-111111111111",
 * "22222222-2222-4222-8222-222222222222","native:42"].
 * Strict ref parsers reject extra fields, including credentials and endpoint metadata.
 */
export function encodeSessionKey(value: SessionRef): SessionKey;
export function decodeSessionKey(value: unknown): SessionRef;
/** Workspace tuple: [1,"workspace",environmentId,platform,volumeId,caseSensitive,canonicalPath].
 * Example target path: "/srv/repo" (posix) or "C:\\Repo" (windows).
 * Paths and volume IDs are opaque target-authoritative values; no case folding or realpath here.
 */
export function encodeWorkspaceKey(value: WorkspaceRef): WorkspaceKey;
export function decodeWorkspaceKey(value: unknown): WorkspaceRef;
/** Repo tuple: [1,"repo",environmentId,platform,volumeId,caseSensitive,canonicalCommonDir].
 * Worktrees share a RepoKey only when the target reports the same Git common-dir and policy.
 */
export function encodeRepoKey(value: RepoRef): RepoKey;
export function decodeRepoKey(value: unknown): RepoRef;
