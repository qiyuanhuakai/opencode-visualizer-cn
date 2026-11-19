import { openProtectedFile } from './protectedFile.js';
import { open, unlink } from 'node:fs/promises';

export async function runSshAskpass() {
  let file, lock, lockPath;
  try {
    if (process.env.VIS_SSH_ASKPASS_MODE !== 'one-shot-v1' || !process.env.VIS_SSH_ASKPASS_FILE) return 1;
    lockPath = process.env.VIS_SSH_ASKPASS_FILE + '.lock';
    lock = await open(lockPath, 'wx', 0o600);
    file = await openProtectedFile(process.env.VIS_SSH_ASKPASS_FILE, true);
    const values = (await file.readFile('utf8')).split('\n');
    const value = values.shift();
    if (!value || /[\0\r]/u.test(value) || Buffer.byteLength(value) > 4096) return 1;
    await file.truncate(0);
    await file.write(values.join('\n'), 0, 'utf8');
    await file.sync();
    await new Promise((resolve, reject) => process.stdout.write(value + '\n', error => error ? reject(error) : resolve()));
    return 0;
  } catch { return 1; }
  finally {
    await file?.close();
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}
