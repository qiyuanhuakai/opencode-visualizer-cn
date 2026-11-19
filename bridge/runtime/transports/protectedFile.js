import { constants } from 'node:fs';
import { chmod, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireValue } from '../../../shared/runtime/capabilities.js';

const execute = promisify(execFile);
async function windowsAcl(file, protect) {
  const script = `
$ErrorActionPreference='Stop'
$file=$env:VIS_PROTECTED_FILE
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=Get-Acl -LiteralPath $file
${protect ? `
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner($user)
foreach($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$flags=[System.Security.AccessControl.InheritanceFlags]::None
if(Test-Path -LiteralPath $file -PathType Container) { $flags=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($user,'FullControl',$flags,[System.Security.AccessControl.PropagationFlags]::None,'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $file -AclObject $acl
$acl=Get-Acl -LiteralPath $file
` : ''}
if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'owner' }
foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
 if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $user.Value) { throw 'access' }
}
`;
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, VIS_PROTECTED_FILE: file }, timeout: 10000, maxBuffer: 1024,
  });
}

export async function protectFile(file, directory = false) {
  if (process.platform === 'win32') await windowsAcl(file, true);
  else await chmod(file, directory ? 0o700 : 0o600);
}

export async function openProtectedFile(file, writable = false) {
  const handle = await open(file, (writable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    requireValue(stat.isFile() && stat.size <= 65536, 'credential.file', 'unauthorized');
    if (process.platform === 'win32') await windowsAcl(file, false);
    else requireValue(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'credential.permissions', 'unauthorized');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
