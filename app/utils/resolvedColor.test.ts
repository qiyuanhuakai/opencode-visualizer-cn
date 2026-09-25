import { describe, expect, it } from 'vitest';
import { isLightResolvedColor } from './resolvedColor';

describe('resolved CSS color brightness', () => {
  it.each([
    ['rgb(255, 255, 255)', true],
    ['rgb(15, 23, 42)', false],
    ['rgba(15, 23, 42, 0.92)', false],
    ['color(srgb 1 1 1)', true],
    ['color(srgb 0.06 0.09 0.16)', false],
  ])('classifies %s', (color, expected) => {
    expect(isLightResolvedColor(color)).toBe(expected);
  });
});
