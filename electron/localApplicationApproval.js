import fs from 'node:fs';
import path from 'node:path';

export function loadApprovedLocalApplication(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return typeof parsed?.path === 'string' && path.isAbsolute(parsed.path) ? parsed.path : null;
  } catch {
    return null;
  }
}

export function persistApprovedLocalApplication(filePath, applicationPath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, JSON.stringify({ path: applicationPath }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
}

export function clearApprovedLocalApplication(filePath) {
  fs.rmSync(filePath, { force: true });
}
