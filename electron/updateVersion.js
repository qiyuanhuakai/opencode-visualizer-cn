const IDENTIFIER = '[0-9A-Za-z-]+';
const VERSION_PATTERN = new RegExp(`^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`, 'u');

export function parseUpdateVersion(value) {
  const match = typeof value === 'string' ? VERSION_PATTERN.exec(value) : null;
  if (!match) throw new Error(`Invalid update version: ${value}`);
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^0\d+$/u.test(part))) {
    throw new Error(`Invalid update version: ${value}`);
  }
  return {
    version: value.replace(/^v/u, ''),
    core: match.slice(1, 4).map(BigInt),
    prerelease,
  };
}

export function isNewerVersion(candidate, current) {
  const next = parseUpdateVersion(candidate);
  if (current === null) return true;
  const installed = parseUpdateVersion(current);
  for (let index = 0; index < 3; index += 1) {
    if (next.core[index] !== installed.core[index]) return next.core[index] > installed.core[index];
  }
  if (next.prerelease.length === 0) return installed.prerelease.length > 0;
  if (installed.prerelease.length === 0) return false;
  for (let index = 0; index < Math.max(next.prerelease.length, installed.prerelease.length); index += 1) {
    const left = next.prerelease[index];
    const right = installed.prerelease[index];
    if (left === right) continue;
    if (left === undefined) return false;
    if (right === undefined) return true;
    const leftNumeric = /^\d+$/u.test(left);
    const rightNumeric = /^\d+$/u.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right);
    if (leftNumeric !== rightNumeric) return rightNumeric;
    return left > right;
  }
  return false;
}

export function parseInstalledVersion(output) {
  const match = /(?:^|\s)(v?\d+\.\d+\.\d+[^\s]*)(?:\s|$)/u.exec(output.trim());
  if (!match) return null;
  try {
    return parseUpdateVersion(match[1]).version;
  } catch {
    return null;
  }
}
