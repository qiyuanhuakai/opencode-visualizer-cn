import { parsePublishedRelease } from './updatePolicy.js';
import { isNewerVersion, parseUpdateVersion } from './updateVersion.js';

export function selectLatestPublishedRelease(values) {
  if (!Array.isArray(values)) throw new Error('GitHub returned invalid release list metadata');
  let latest = null;
  for (const value of values) {
    if (typeof value !== 'object' || value === null || typeof value.draft !== 'boolean' ||
      typeof value.prerelease !== 'boolean' || typeof value.tag_name !== 'string') {
      throw new Error('GitHub returned invalid release list metadata');
    }
    if (value.draft) continue;
    let version;
    try {
      version = parseUpdateVersion(value.tag_name).version;
    } catch {
      continue;
    }
    if (latest === null || isNewerVersion(version, latest.version)) latest = { version, value };
  }
  return latest === null ? null : { ...parsePublishedRelease(latest.value), tagName: latest.value.tag_name };
}
