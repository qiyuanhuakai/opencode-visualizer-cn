import { describe, expect, it } from 'vitest';
import { preserveProgressiveRootLimit } from './progressiveRoots';

describe('preserveProgressiveRootLimit', () => {
  it('keeps previously loaded roots when a live root appends', () => {
    const previous = Array.from({ length: 40 }, (_, index) => `root-${index}`);

    expect(
      preserveProgressiveRootLimit(previous, [...previous, 'root-40'], 40),
    ).toBe(41);
  });

  it('does not consume prepended history before the user reaches the top', () => {
    expect(
      preserveProgressiveRootLimit(['root-20', 'root-21'], ['root-19', 'root-20', 'root-21'], 2),
    ).toBe(2);
  });
});
