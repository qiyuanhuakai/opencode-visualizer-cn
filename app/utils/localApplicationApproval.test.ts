import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearApprovedLocalApplication,
  loadApprovedLocalApplication,
  persistApprovedLocalApplication,
} from '../../electron/localApplicationApproval.js';

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('local application approval', () => {
  it('does not report a cleared approval when deleting the approval file fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-approval-test-'));
    directories.push(directory);
    const filePath = path.join(directory, 'local-application.json');
    persistApprovedLocalApplication(filePath, process.execPath);
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw new Error('permission denied');
    });

    expect(() => clearApprovedLocalApplication(filePath)).toThrow('permission denied');
    expect(loadApprovedLocalApplication(filePath)).toBe(process.execPath);
  });
});
