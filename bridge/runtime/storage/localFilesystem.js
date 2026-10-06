import { statfsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { StoreError } from './storeProtocol.js';
export function classifyFilesystem(platform, type) {
  const local = platform === 'linux' ? ['ef53', '58465342', '9123683e', '2fc12fc1'] : platform === 'darwin' ? ['apfs', 'hfs'] : platform === 'win32' ? ['NTFS:3', 'ReFS:3'] : [];
  if (!local.includes(type)) throw new StoreError('unsupported', 'unverified_local_filesystem');
  return { platform, type, local: true };
}
export function probeLocalFilesystem(directory) {
  const canonicalPath = realpathSync(directory);
  let type;
  switch (process.platform) {
    case 'linux': type = statfsSync(canonicalPath).type.toString(16); break;
    case 'darwin': type = execFileSync('/usr/bin/stat', ['-f', '%T', canonicalPath], { encoding: 'utf8', timeout: 5000 }).trim(); break;
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
