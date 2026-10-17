import { statfsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { StoreError } from './storeProtocol.js';
export function classifyFilesystem(platform, type) {
  const local = platform === 'linux' ? ['ef53', '58465342', '9123683e', '2fc12fc1'] : platform === 'darwin' ? ['apfs', 'hfs'] : platform === 'win32' ? ['NTFS:3', 'ReFS:3'] : [];
  if (!local.includes(type)) throw new StoreError('unsupported', 'unverified_local_filesystem');
  return { platform, type, local: true };
}
/** Darwin assigns filesystem type numbers at runtime, so the mount table's type name is the
 * stable identity; stat(1) has no statfs mode there and its %T is the file type, not the fs.
 * mount(1) prints "<source> on <mount point> (<type>, ...)" and either side may itself contain
 * " on ", so a single split of the line cannot identify the mount point: every split the printed
 * grammar allows is collected, only mount points covering canonicalPath compete, and covering
 * records that disagree refuse the probe instead of guessing a volume. */
export function darwinMountType(mountOutput, canonicalPath) {
  const covering = [];
  for (const line of mountOutput.split('\n')) {
    const options = line.lastIndexOf(' (');
    if (options < 0) continue;
    const type = /^\(([^,)]+)[,)]/.exec(line.slice(options + 1))?.[1];
    if (type === undefined) continue;
    const record = line.slice(0, options);
    for (let at = record.indexOf(' on '); at >= 0; at = record.indexOf(' on ', at + 4)) {
      const mountPoint = record.slice(at + 4);
      if (mountPoint !== '' && (mountPoint === '/' || canonicalPath === mountPoint || canonicalPath.startsWith(`${mountPoint}/`))) covering.push({ mountPoint, type });
    }
  }
  if (covering.length === 0) throw new StoreError('unsupported', 'unverified_local_filesystem');
  const deepest = Math.max(...covering.map((candidate) => candidate.mountPoint.length));
  const records = covering.filter((candidate) => candidate.mountPoint.length === deepest);
  if (new Set(records.map((candidate) => candidate.type)).size > 1) throw new StoreError('unsupported', 'unverified_local_filesystem');
  return records[0].type;
}
export function probeLocalFilesystem(directory) {
  const canonicalPath = realpathSync(directory);
  let type;
  switch (process.platform) {
    case 'linux': type = statfsSync(canonicalPath).type.toString(16); break;
    case 'darwin': type = darwinMountType(execFileSync('/sbin/mount', { encoding: 'utf8', timeout: 5000 }), canonicalPath); break;
    case 'win32': {
      if (!/^[A-Za-z]:\\/.test(canonicalPath)) throw new StoreError('unsupported', 'unverified_local_filesystem');
      const drive = canonicalPath.slice(0, 2);
      type = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"; Write-Output ($d.FileSystem+':'+$d.DriveType)`], { encoding: 'utf8', timeout: 5000 }).trim();
      break;
    }
    default: throw new StoreError('unsupported', 'unverified_local_filesystem');
  }
  return { ...classifyFilesystem(process.platform, type), canonicalPath };
}
