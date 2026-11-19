import { expect, it } from 'vitest';
import { hostSessionSelection } from './hostThreadViews';
import { unavailableRegistration } from '../../bridge/runtime/runtimeDriverFactories.js';
import { parseEnvironmentId, parseHarnessInstanceId, encodeWorkspaceKey, parseSessionRef } from '../../shared/runtime/identity.js';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const other = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const harnessInstanceId = parseHarnessInstanceId('33333333-3333-4333-8333-333333333333');
const manifest = unavailableRegistration({ environmentId, harnessInstanceId, kind: 'codex' }, 'starting').manifest;
const session = parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId: 'same-native-id' });
const workspace = { environmentId, canonicalPath: '/outside-the-rendered-page', pathPolicy: { platform: 'posix' as const, volumeId: 'test', caseSensitive: true } };

it('decodes an authoritative off-page selection independently of visible tree rows', () => {
  const result = hostSessionSelection({ session, manifest, directory: workspace.canonicalPath, workspaceKey: encodeWorkspaceKey(workspace) });
  expect(result).toEqual({ session, manifest, directory: workspace.canonicalPath, workspaceKey: encodeWorkspaceKey(workspace) });
  expect(hostSessionSelection({ session, manifest, directory: null, workspaceKey: null })).toMatchObject({ directory: null, workspaceKey: null });
  expect(hostSessionSelection({ session, manifest, directory: null, workspaceKey: null, title: 'Pinned off-page session', status: 'idle' })).toMatchObject({ title: 'Pinned off-page session', status: 'idle' });
});

it('refuses mismatched source or workspace identities and unbounded directory metadata', () => {
  const value = { session, manifest, directory: workspace.canonicalPath, workspaceKey: encodeWorkspaceKey(workspace) };
  expect(() => hostSessionSelection({ ...value, manifest: { ...manifest, environmentId: other } })).toThrow('selection_identity');
  expect(() => hostSessionSelection({ ...value, workspaceKey: encodeWorkspaceKey({ ...workspace, environmentId: other }) })).toThrow('selection_workspace');
  expect(() => hostSessionSelection({ ...value, directory: 'x'.repeat(16385) })).toThrow('selection_directory');
  expect(() => hostSessionSelection({ ...value, title: 'x'.repeat(8193) })).toThrow('selection_label');
});
