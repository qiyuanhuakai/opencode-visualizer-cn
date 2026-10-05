import { describe, expect, it } from 'vitest';
import {
  IdentityError, decodeRepoKey, decodeSessionKey, decodeWorkspaceKey,
  encodeRepoKey, encodeSessionKey, encodeWorkspaceKey, parseConnectionProfileId,
  parseEnvironmentId, parseHarnessInstanceId, parseInstanceId, parseRepoRef,
  parseSessionRef, parseWorkspaceRef, resolveEnvironmentId,
} from '../shared/runtime/identity.js';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const secondEnvironment = parseEnvironmentId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const harnesses = ['opencode', 'codex', 'acp', 'kimi-web', 'dsh'].map((kind, index) => ({
  kind, id: parseHarnessInstanceId(`22222222-2222-4222-8222-22222222222${index}`),
}));
const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222220');
const session = { environmentId, harnessInstanceId, nativeSessionId: 'same-native-id' };
const posix = { platform: 'posix', volumeId: 'volume-1', caseSensitive: true } as const;
const windows = { platform: 'windows', volumeId: 'volume-C', caseSensitive: false } as const;
const workspace = { environmentId, canonicalPath: '/srv/repo', pathPolicy: posix };
const rawKey = (tuple: unknown) => Buffer.from(JSON.stringify(tuple)).toString('base64url');

describe('runtime identity', () => {
  it('isolates five harnesses across two environments when native IDs repeat', () => {
    const refs = [environmentId, secondEnvironment].flatMap((environmentId) =>
      harnesses.map(({ id }) => ({ environmentId, harnessInstanceId: id, nativeSessionId: 'same' })));
    const keys = refs.map(encodeSessionKey);
    expect(new Set(keys).size).toBe(10);
    expect(keys.map(decodeSessionKey)).toEqual(refs);
  });
  it('normalizes persisted UUIDs while distinguishing profile and process instances', () => {
    expect(parseEnvironmentId(secondEnvironment.toUpperCase())).toBe(secondEnvironment);
    expect(parseConnectionProfileId(environmentId)).toBe(environmentId);
    expect(parseInstanceId(secondEnvironment)).not.toBe(parseInstanceId(environmentId));
  });
  it.each(['local', 'direct', 'ssh'])('keeps %s bound to its persisted target identity', (kind) => {
    expect(resolveEnvironmentId({ kind, environmentId })).toBe(environmentId);
  });
  it('keeps Slurm bound to the persisted cluster environment', () => {
    expect(resolveEnvironmentId({ kind: 'slurm', clusterEnvironmentId: environmentId })).toBe(environmentId);
  });
  it.each(['/srv/repo', '/srv/目录\\literal', 'C:\\Repo', '\\\\server\\share\\Repo'])('roundtrips target path %s', (canonicalPath) => {
    const ref = { environmentId, canonicalPath, pathPolicy: canonicalPath.startsWith('/') ? posix : windows };
    expect(decodeWorkspaceKey(encodeWorkspaceKey(ref))).toEqual(ref);
  });
  it('groups different worktrees by their target Git common-dir', () => {
    const repo = { environmentId, canonicalCommonDir: '/srv/repo/.git', pathPolicy: posix };
    const worktrees = ['/srv/repo', '/srv/feature'].map((canonicalPath) => ({ ...workspace, canonicalPath }));
    expect(new Set(worktrees.map(encodeWorkspaceKey)).size).toBe(2);
    expect(decodeRepoKey(encodeRepoKey(repo))).toEqual(repo);
    expect(encodeRepoKey({ ...repo })).toBe(encodeRepoKey(repo));
    expect(encodeRepoKey(repo)).not.toBe(encodeRepoKey({ ...repo, environmentId: secondEnvironment }));
  });
  it('keeps profile credentials outside identity serialization', () => {
    const profile = { username: 'secret-user', endpoint: 'https://secret-user:password@example.test', session };
    const decoded = Buffer.from(encodeSessionKey(profile.session), 'base64url').toString();
    expect(JSON.parse(decoded)).toEqual([1, 'session', environmentId, harnessInstanceId, 'same-native-id']);
    expect(decoded).not.toMatch(/secret-user|password|example/);
  });
  it('copies and freezes refs so later input mutation cannot change a stored identity', () => {
    const source = { ...workspace, pathPolicy: { ...posix, volumeId: String(posix.volumeId) } };
    const parsed = parseWorkspaceRef(source);
    source.canonicalPath = '/stale';
    source.pathPolicy.volumeId = 'changed';
    expect(parsed).toEqual(workspace);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.pathPolicy)).toBe(true);
  });
});

describe('failure identity boundaries', () => {
  it.each(['a:b', 'a|b', '["x",null]', '雪/😀', '\u0000', '\ud800', '__proto__'])('isolates delimiter/native ID %j without loss', (nativeSessionId) => {
    const ref = { ...session, nativeSessionId };
    const key = encodeSessionKey(ref);
    expect(decodeSessionKey(key)).toEqual(ref);
    expect(key).not.toBe(encodeSessionKey({ ...ref, nativeSessionId: `${nativeSessionId}:` }));
  });
  it.each(['', ' ', 'localhost:12345', 'https://user:pass@host', 'compute-07', '1234', null, 42])('rejects nonpersistent environment %j', (value) => {
    expect(() => parseEnvironmentId(value)).toThrow(IdentityError);
  });
  it.each([null, {}, { ...session, nativeSessionId: '' }, { ...session, nativeSessionId: ' ' },
    { ...session, harnessInstanceId: 'acp' }, { ...session, username: 'secret' },
    { ...session, endpoint: 'http://localhost:1234' }])('rejects malformed or credential-bearing ref %j', (value) => {
    expect(() => parseSessionRef(value)).toThrow(IdentityError);
  });
  it.each([{ kind: 'slurm', environmentId }, { kind: 'slurm', clusterEnvironmentId: 'compute-07' },
    { kind: 'ssh', environmentId: 'localhost:54321' }, { kind: 'direct', environmentId, port: 54321 },
    { kind: 'slurm', clusterEnvironmentId: environmentId, jobId: '456' }, { kind: 'other', environmentId }])('rejects transient environment binding %j', (value) => {
    expect(() => resolveEnvironmentId(value)).toThrow(IdentityError);
  });
  it.each(['relative', '/srv/../repo', '/srv/./repo', '/srv//repo', '/srv/repo/', 'https://user:pass@host/repo', ''])('rejects noncanonical path %j', (canonicalPath) => {
    expect(() => parseWorkspaceRef({ ...workspace, canonicalPath })).toThrow(IdentityError);
  });
  it('isolates volumes, hosts, case policies and distinct resolved symlink destinations', () => {
    const refs = [workspace, { ...workspace, environmentId: secondEnvironment },
      { ...workspace, pathPolicy: { ...posix, volumeId: 'volume-2' } },
      { ...workspace, pathPolicy: { ...posix, caseSensitive: false } },
      { ...workspace, canonicalPath: '/other/symlink-target' }, { ...workspace, canonicalPath: '/srv/Repo' }];
    expect(new Set(refs.map(encodeWorkspaceKey)).size).toBe(6);
  });
  it.each([{ ...workspace, pathPolicy: { ...posix, volumeId: '' } },
    { ...workspace, pathPolicy: { ...posix, caseSensitive: 'false' } },
    { ...workspace, pathPolicy: { ...posix, platform: 'local' } },
    { ...workspace, canonicalPath: 'C:repo', pathPolicy: windows },
    { ...workspace, canonicalPath: 'C:/repo', pathPolicy: windows }])('rejects ambiguous target policy %j', (value) => {
    expect(() => parseWorkspaceRef(value)).toThrow(IdentityError);
  });
  it('rejects remote URLs as repository identity', () => {
    expect(() => parseRepoRef({ environmentId, canonicalCommonDir: 'https://host/repo', pathPolicy: posix })).toThrow(IdentityError);
  });
  it.each(['', '%%%', 'e30', 'W10', rawKey([1, 'session', environmentId]),
    rawKey([1, 'session', environmentId, harnessInstanceId, 'id', 'extra']),
    rawKey([1, 'session', environmentId, harnessInstanceId, 'id']) + '=', '_w'])('rejects malformed encoded identity %j', (value) => {
    expect(() => decodeSessionKey(value)).toThrow(IdentityError);
  });
  it('reports stale schema explicitly without echoing untrusted input', () => {
    expect(() => decodeSessionKey(rawKey([2, 'session', 'password']))).toThrow(
      expect.objectContaining({ code: 'unsupported_identity_version', field: 'schemaVersion' }));
  });
  it('rejects keys from a different identity scope', () => {
    expect(() => decodeSessionKey(encodeWorkspaceKey(workspace))).toThrow(IdentityError);
    expect(() => decodeRepoKey(encodeWorkspaceKey(workspace))).toThrow(IdentityError);
    expect(() => decodeWorkspaceKey(encodeSessionKey(session))).toThrow(IdentityError);
  });
  it('rejects alternate encodings of the same tuple', () => {
    const tuple = [1, 'session', environmentId, harnessInstanceId, 'id'];
    const pretty = Buffer.from(JSON.stringify(tuple, null, 2)).toString('base64url');
    expect(() => decodeSessionKey(pretty)).toThrow(IdentityError);
  });
});
