import type { BackendAdapter, BackendCapabilities, BackendKind } from '../backends/types';

export function capturedBackend(kind: BackendKind, capabilities: BackendCapabilities, native: Partial<BackendAdapter>, workspace: Partial<BackendAdapter>): BackendAdapter {
  const unsupported = async () => { throw new Error('runtime.native: operation is not declared by this instance'); };
  const required: BackendAdapter = {
    kind, label: native.label ?? kind, capabilities,
    createSession: unsupported, forkSession: unsupported, updateSession: unsupported,
    deleteSession: unsupported, revertSession: unsupported, unrevertSession: unsupported,
    listSessions: unsupported, updateProject: unsupported, createWorktree: unsupported,
    deleteWorktree: unsupported,
  };
  return new Proxy(required, {
    get(target, key) {
      const owner = key in workspace ? workspace : key in native ? native : target;
      const value: unknown = Reflect.get(owner, key);
      return typeof value === 'function' ? value.bind(owner) : value;
    },
  });
}
