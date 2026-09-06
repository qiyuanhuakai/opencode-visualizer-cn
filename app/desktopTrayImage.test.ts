import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import { resolveApplicationTrayIconPath } from '../electron/applicationTrayIcon.js';

const root = path.resolve(__dirname, '..');
const canonicalIconPath = path.join(root, 'build/icon.png');

it('uses the canonical application PNG as the tray image source', () => {
  // Given: the official Linux application icon.
  const png = readFileSync(canonicalIconPath);

  // When: its native-image metadata is inspected.
  // Then: it remains the complete 512px RGBA source rather than a tray-only placeholder.
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png.readUInt32BE(16)).toBe(512);
  expect(png.readUInt32BE(20)).toBe(512);
  expect(png[24]).toBe(16);
  expect(png[25]).toBe(6);
  expect(createHash('sha256').update(png).digest('hex')).toBe(
    'accb4d38a02c7e59edc2d57d574bfa3b3651e26e6e8d06f59e2b9c0de81386fc',
  );
  expect(
    resolveApplicationTrayIconPath(
      { getAppPath: () => path.resolve(__dirname, '..'), isPackaged: false },
      '/unused',
    ),
  ).toBe(canonicalIconPath);
});

it('packages the canonical application icon at the tray runtime resource path', () => {
  // Given: electron-builder's resource map.
  const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');

  // When: the canonical icon mapping is located.
  // Then: it is copied outside the ASAR under the stable runtime filename.
  expect(builder).toMatch(
    /^extraResources:\s*\n\s*- from: build\/icon\.png\s*\n\s+to: application-icon\.png$/mu,
  );
  expect(
    resolveApplicationTrayIconPath(
      { getAppPath: () => '/unused', isPackaged: true },
      '/opt/Vis/resources',
    ),
  ).toBe('/opt/Vis/resources/application-icon.png');
});
