import { randomUUID } from 'node:crypto';
import { mkdir, readFile, link, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnvironmentId } from '../../shared/runtime/identity.js';

export async function loadEnvironmentIdentity(stateRoot) {
  const directory = path.join(stateRoot, 'runtime');
  const filename = path.join(directory, 'environment.json');
  try {
    return parseEnvironmentId(JSON.parse(await readFile(filename, 'utf8')).environmentId);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.environment-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ environmentId: randomUUID() }), {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    try {
      await link(temporary, filename);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
  } finally {
    await unlink(temporary);
  }
  return parseEnvironmentId(JSON.parse(await readFile(filename, 'utf8')).environmentId);
}
