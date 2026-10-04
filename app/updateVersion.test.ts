import { describe, expect, it } from 'vitest';
import { isNewerVersion, parseInstalledVersion } from '../electron/updatePolicy.js';

describe('shared updater SemVer precedence', () => {
  it.each([
    ['0.8.20-alpha.1', '0.8.19', true],
    ['0.8.20-alpha.10', '0.8.20-alpha.2', true],
    ['0.8.20-beta', '0.8.20-alpha.10', true],
    ['0.8.20-rc.1', '0.8.20-beta', true],
    ['0.8.20', '0.8.20-rc.1', true],
    ['0.8.20-alpha.1', '0.8.20', false],
    ['0.8.20-alpha.1+build.2', '0.8.20-alpha.1+build.1', false],
    ['0.8.20-alpha.a', '0.8.20-alpha.9', true],
    ['0.8.20-alpha.1.1', '0.8.20-alpha.1', true],
    ['v0.8.20-alpha.2', 'v0.8.20-alpha.1', true],
  ])('compares %s against %s as %s', (candidate, current, newer) => {
    // Given/When: compare versions from release metadata and installed binaries.
    const result = isNewerVersion(candidate, current);
    // Then: numeric identifiers and stable releases follow SemVer precedence.
    expect(result).toBe(newer);
  });

  it.each(['01.2.3', '1.2.3-alpha.01', '1.2.3-', '1.2.3/evil', '1.2', '1.2.3+']) (
    'rejects malformed version %s even before an initial install', (version) => {
      // Given/When/Then: absence of an installed version cannot bypass validation.
      expect(() => isNewerVersion(version, null)).toThrow('Invalid update version');
    },
  );

  it.each([
    ['vis_bridge 0.8.20-alpha.1\n', '0.8.20-alpha.1'],
    ['v0.8.20-rc.2+build.7', '0.8.20-rc.2+build.7'],
    ['vis_bridge 0.8.20-alpha.01', null],
    ['vis_bridge 0.8.20-invalid/path', null],
  ])('retains the full installed version from %s', (output, version) => {
    // Given/When/Then: CLI probes retain suffixes and reject partial matches.
    expect(parseInstalledVersion(output)).toBe(version);
  });
});
