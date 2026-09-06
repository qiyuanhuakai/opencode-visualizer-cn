import { expect, it } from 'vitest';
import { bridgeVersionPaths } from '../electron/bridgeVersionPaths.js';

it.each([
  ['darwin', undefined, '/usr/local/bin/vis_bridge'],
  ['linux', undefined, '/usr/bin/vis_bridge'],
  ['win32', 'C:\\Users\\qa\\AppData\\Local', 'C:\\Users\\qa\\AppData\\Local\\Programs\\vis_bridge\\vis_bridge.exe'],
])('finds the native installer destination for %s without depending on GUI PATH', (platform, localAppData, expected) => {
  expect(bridgeVersionPaths(platform ?? '', localAppData)).toEqual([expected, 'vis_bridge']);
});
