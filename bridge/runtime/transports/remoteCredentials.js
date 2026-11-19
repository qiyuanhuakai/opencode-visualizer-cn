import path from 'node:path';
import { objectFields, requireValue } from '../../../shared/runtime/capabilities.js';
import { openProtectedFile } from './protectedFile.js';

export function createRemoteCredentialResolver(stateRoot) {
  return async reference => {
    if (['system', 'system:password', 'system:passphrase', 'system:keyboard-interactive', 'system:agent'].includes(reference)) return {};
    requireValue(stateRoot && typeof reference === 'string' && reference.length <= 256, 'credential.reference', 'unauthorized');
    const file = await openProtectedFile(path.join(stateRoot, 'remote-credentials.json'));
    try {
      const entries = JSON.parse(await file.readFile('utf8'));
      requireValue(entries !== null && typeof entries === 'object' && !Array.isArray(entries), 'credential.store');
      requireValue(Object.hasOwn(entries, reference), 'credential.missing', 'unauthorized');
      const value = objectFields(entries[reference], [], ['bridgeToken', 'ssh']);
      if (value.bridgeToken !== undefined) requireValue(typeof value.bridgeToken === 'string' && value.bridgeToken.length > 0 && value.bridgeToken.length <= 4096, 'credential.token');
      if (value.ssh !== undefined) objectFields(value.ssh, [], ['configPath', 'knownHostsPath', 'passphraseRequired', 'method', 'remotePort']);
      return value;
    } finally { await file.close(); }
  };
}
