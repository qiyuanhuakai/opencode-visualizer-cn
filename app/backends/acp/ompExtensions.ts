import { toRecord } from './wire';

const extensionStates = new Set(['active', 'disabled', 'shadowed']);

export type OmpExtension = {
  id: string;
  kind: string;
  name: string;
  displayName: string;
  path: string;
  state: 'active' | 'disabled' | 'shadowed';
};

export type BackendPluginStatus = {
  id: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  accessible: boolean;
};

export function parseOmpExtensions(value: unknown): OmpExtension[] {
  const record = toRecord(value);
  if (!record || !Array.isArray(record.extensions)) {
    throw new Error('Invalid Oh My Pi extension status response.');
  }
  return record.extensions.map((item) => {
    const extension = toRecord(item);
    if (
      !extension ||
      typeof extension.id !== 'string' ||
      typeof extension.kind !== 'string' ||
      typeof extension.name !== 'string' ||
      typeof extension.displayName !== 'string' ||
      typeof extension.path !== 'string' ||
      typeof extension.state !== 'string' ||
      !extensionStates.has(extension.state)
    ) {
      throw new Error('Invalid Oh My Pi extension status entry.');
    }
    return {
      id: extension.id,
      kind: extension.kind,
      name: extension.name,
      displayName: extension.displayName,
      path: extension.path,
      state: extension.state as OmpExtension['state'],
    };
  });
}

export function toOmpMcpStatus(extensions: OmpExtension[]) {
  return Object.fromEntries(
    extensions
      .filter((extension) => extension.kind === 'mcp')
      .map((extension) => [
        extension.displayName,
        { status: extension.state === 'active' ? 'configured' as const : 'disabled' as const },
      ]),
  );
}

export function toOmpSkillStatus(extensions: OmpExtension[]) {
  return extensions
    .filter((extension) => extension.kind === 'skill')
    .map((extension) => ({
      name: extension.displayName,
      enabled: extension.state === 'active',
      path: extension.path,
    }));
}

export function toOmpPluginStatus(extensions: OmpExtension[]): BackendPluginStatus[] {
  return extensions
    .filter((extension) => extension.kind === 'extension-module')
    .map((extension) => ({
      id: extension.id,
      name: extension.displayName,
      enabled: extension.state === 'active',
      installed: true,
      accessible: extension.state !== 'shadowed',
    }));
}
