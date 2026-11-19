import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { parseConnectionProfileId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import { requireValue, objectFields } from '../../shared/runtime/capabilities.js';

export async function loadRuntimeRegistrations(stateRoot, keys) {
  const directory = path.join(stateRoot, 'runtime', 'registrations');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  async function identity(name, parser) {
    const filename = path.join(directory, name + '.json');
    async function read() { const value = objectFields(JSON.parse(await readFile(filename, 'utf8')), ['id']); return parser(value.id); }
    try { return await read(); }
    catch (error) { if (!(error instanceof Error) || error.code !== 'ENOENT') throw error; }
    const temporary = path.join(directory, '.' + randomUUID() + '.tmp');
    await writeFile(temporary, JSON.stringify({ id: randomUUID() }), { flag: 'wx', mode: 0o600 });
    try { await link(temporary, filename); }
    catch (error) { if (!(error instanceof Error) || error.code !== 'EEXIST') throw error; }
    finally { await unlink(temporary); }
    return read();
  }
  requireValue(Array.isArray(keys) && keys.length <= 128 && new Set(keys).size === keys.length, 'registrations.keys');
  const harnesses = new Map();
  for (const key of keys) {
    requireValue(typeof key === 'string' && key.length > 0 && key.length <= 512, 'registration.key');
    harnesses.set(key, await identity(Buffer.from(key).toString('base64url'), parseHarnessInstanceId));
  }
  return { connectionProfileId: await identity('management-profile', parseConnectionProfileId), harnesses };
}

