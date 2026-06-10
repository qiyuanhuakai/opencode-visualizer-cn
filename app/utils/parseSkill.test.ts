import { describe, expect, it } from 'vitest';

import type { CodexSkill } from '../backends/codex/codexAdapter';
import { parseSkill } from './parseSkill';

const skills: CodexSkill[] = [
  { name: 'skill-creator', description: 'd', enabled: true, path: '/abs/skill-creator/SKILL.md' },
  { name: 'codex-debug', description: 'd', enabled: true, path: '/abs/codex-debug/SKILL.md' },
  { name: 'no-path', description: 'd', enabled: true },
  { name: 'disabled', description: 'd', enabled: false, path: '/abs/disabled/SKILL.md' },
];

describe('parseSkill', () => {
  it('returns empty for empty input', () => {
    expect(parseSkill('', skills)).toEqual([]);
  });

  it('returns empty when no $ tokens', () => {
    expect(parseSkill('hello world, no skill tokens here', skills)).toEqual([]);
  });

  it('extracts a single $skill-creator token', () => {
    expect(parseSkill('use $skill-creator please', skills)).toEqual([
      { name: 'skill-creator', path: '/abs/skill-creator/SKILL.md' },
    ]);
  });

  it('extracts multiple skills preserving order', () => {
    expect(parseSkill('$codex-debug then $skill-creator', skills)).toEqual([
      { name: 'codex-debug', path: '/abs/codex-debug/SKILL.md' },
      { name: 'skill-creator', path: '/abs/skill-creator/SKILL.md' },
    ]);
  });

  it('deduplicates by name', () => {
    expect(parseSkill('$skill-creator and $skill-creator', skills)).toEqual([
      { name: 'skill-creator', path: '/abs/skill-creator/SKILL.md' },
    ]);
  });

  it('skips skills missing a path', () => {
    expect(parseSkill('try $no-path', skills)).toEqual([]);
  });

  it('skips unknown $tokens', () => {
    expect(parseSkill('what about $unknown-thing', skills)).toEqual([]);
  });

  it('still extracts even if disabled in UI state', () => {
    expect(parseSkill('use $disabled', skills)).toEqual([
      { name: 'disabled', path: '/abs/disabled/SKILL.md' },
    ]);
  });

  it('returns empty when skills list is empty', () => {
    expect(parseSkill('$skill-creator', [])).toEqual([]);
  });

  it('passes through $1 style without crashing (no match in skills)', () => {
    expect(parseSkill('cost is $1', skills)).toEqual([]);
  });
});
