import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseInstalledVersion } from './updatePolicy.js';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 15_000;

export function parseWslDistros(output) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
  const utf16 = bytes.length >= 2 && (bytes[0] === 0xff && bytes[1] === 0xfe);
  const nulDelimited = bytes.subarray(0, Math.min(bytes.length, 64)).includes(0);
  const decoded = bytes.toString(utf16 || nulDelimited ? 'utf16le' : 'utf8');
  return decoded.replace(/^\ufeff/u, '').split(/\r?\n/u)
    .map((name) => name.trim())
    .filter((name) => name && [...name].every((character) => {
      const code = character.codePointAt(0);
      return code >= 32 && code !== 127;
    }));
}

export async function findLocalWslBridge(version, runCommand = execFileAsync, signal) {
  if (!version) return null;
  let distros;
  try {
    const { stdout } = await runCommand('wsl.exe', ['--list', '--quiet'], {
      encoding: 'buffer', timeout: PROBE_TIMEOUT_MS, windowsHide: true, signal,
    });
    distros = parseWslDistros(stdout);
  } catch {
    return null;
  }
  const matches = await Promise.all(distros.map(async (distro) => {
    try {
      const { stdout } = await runCommand('wsl.exe',
        ['--distribution', distro, '--exec', 'vis_bridge', '--version'],
        { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, signal });
      return parseInstalledVersion(stdout) === version ? distro : null;
    } catch {
      return null;
    }
  }));
  const candidates = matches.filter(Boolean);
  return candidates.length === 1 ? candidates[0] : null;
}

export function openWslBridgeTerminal(distro, launch = spawn, localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) return Promise.reject(new Error('LOCALAPPDATA is required to launch Windows Terminal'));
  const terminal = path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe');
  const args = [
    '-w', 'new', 'new-tab', '--title', `vis_bridge (${distro})`, 'wsl.exe', '--distribution', distro,
    '--exec', 'sh', '-lc', 'vis_bridge update\nexec "${SHELL:-/bin/sh}" -l',
  ];
  return new Promise((resolve, reject) => {
    const child = launch(terminal, args, { stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
