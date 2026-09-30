import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DSH_CAPABILITIES } from './dshAdapter';
import { DSH_ADAPTER_METHODS } from './dshAdapter';
import type { BackendCapabilities } from '../types';
import {
  DSH_BEHAVIORAL_FALSE_FLAGS,
  DSH_CAPABILITY_REGISTRY,
  DSH_EXCLUDED_UI_FEATURES,
  DSH_FALSE_CAPABILITY_ENFORCEMENT,
  DSH_FALSE_CAPABILITY_KEYS,
  deriveDshBooleanFalseKeys,
} from './capabilities';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The exact negative UI feature list the plan requires dsh's capability page to omit. */
const REQUIRED_EXCLUDED_LABELS = [
  '投票',
  '深研',
  '计时器',
  '压缩',
  'Recents',
  '工作区',
  'web',
  'tabby',
] as const;

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function repoFileExists(relativePath: string): boolean {
  return existsSync(path.join(REPO_ROOT, relativePath));
}

describe('dsh capability registry (static, derived from DSH_CAPABILITIES)', () => {
  // RED core: the registry must never become a second source of truth.
  it('derives every capability value from DSH_CAPABILITIES (no drift)', () => {
    expect(DSH_CAPABILITY_REGISTRY).toEqual(DSH_CAPABILITIES);
    for (const key of Object.keys(DSH_CAPABILITIES) as (keyof BackendCapabilities)[]) {
      expect(DSH_CAPABILITY_REGISTRY[key]).toBe(DSH_CAPABILITIES[key]);
    }
  });

  it('partitions every runtime-derived false bit into capabilities vs behavioral toggles', () => {
    expect([...DSH_FALSE_CAPABILITY_KEYS, ...DSH_BEHAVIORAL_FALSE_FLAGS].sort()).toEqual(
      deriveDshBooleanFalseKeys(),
    );
    const overlap = DSH_FALSE_CAPABILITY_KEYS.filter((key) =>
      (DSH_BEHAVIORAL_FALSE_FLAGS as readonly string[]).includes(key),
    );
    expect(overlap).toEqual([]);
  });

  it('is exhaustive: every false capability has an enforcement anchor', () => {
    for (const capability of DSH_FALSE_CAPABILITY_KEYS) {
      const anchor = DSH_FALSE_CAPABILITY_ENFORCEMENT[capability];
      expect(anchor, `false capability ${capability} has no anchor`).toBeTruthy();
      expect(anchor.file).toBeTruthy();
      expect(anchor.symbol).toBeTruthy();
      expect(anchor.test).toBeTruthy();
      expect(anchor.summary).toBeTruthy();
    }
  });

  // Anti "misleading_success_output": an anchor that no longer exists is a dead link.
  it('has no dead links: every anchor file contains its symbol and exists', () => {
    for (const capability of DSH_FALSE_CAPABILITY_KEYS) {
      const anchor = DSH_FALSE_CAPABILITY_ENFORCEMENT[capability];
      expect(
        repoFileExists(anchor.file),
        `${capability}: anchor file ${anchor.file} is missing`,
      ).toBe(true);
      expect(
        readRepoFile(anchor.file),
        `${capability}: anchor symbol "${anchor.symbol}" not found in ${anchor.file}`,
      ).toContain(anchor.symbol);
      expect(
        repoFileExists(anchor.test),
        `${capability}: pinning test ${anchor.test} is missing`,
      ).toBe(true);
    }
  });

  it('covers the required negative UI feature list exhaustively and once each', () => {
    const labels = DSH_EXCLUDED_UI_FEATURES.map((feature) => feature.label);
    expect([...labels].sort()).toEqual([...REQUIRED_EXCLUDED_LABELS].sort());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('maps every named feature that has a dsh capability onto a genuinely false bit', () => {
    const falseCapabilities = new Set<string>(DSH_FALSE_CAPABILITY_KEYS);
    let mapped = 0;
    for (const feature of DSH_EXCLUDED_UI_FEATURES) {
      if (feature.capability === null) continue;
      mapped += 1;
      expect(DSH_CAPABILITIES[feature.capability]).toBe(false);
      expect(falseCapabilities.has(feature.capability)).toBe(true);
    }
    // 压缩→sessionCompact and 工作区→worktrees are the two named features that
    // correspond to real dsh capability bits; every other named feature has no
    // Vis surface at all (asserted by the exhaustive label test above).
    expect(mapped).toBe(2);
  });

  it('exposes no adapter method for a false capability with no protocol surface', () => {
    expect(DSH_ADAPTER_METHODS).not.toContain('replyQuestion');
    expect(DSH_ADAPTER_METHODS).not.toContain('listPendingQuestions');
    expect(DSH_ADAPTER_METHODS).not.toContain('getSessionTodos');
    expect(DSH_ADAPTER_METHODS.some((method) => /compact/i.test(method))).toBe(false);
  });
});
