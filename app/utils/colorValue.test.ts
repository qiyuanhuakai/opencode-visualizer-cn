import { describe, expect, it } from 'vitest';
import { parseOpaqueColor, rgbHex } from './colorValue';

describe('opaque theme colors', () => {
  it('accepts solid hex, rgb and hsl colors used by imported themes', () => {
    expect(rgbHex(parseOpaqueColor('#abc')!)).toBe('#aabbcc');
    expect(rgbHex(parseOpaqueColor('rgb(240 241 237)')!)).toBe('#f0f1ed');
    expect(rgbHex(parseOpaqueColor('hsl(0 0% 20%)')!)).toBe('#333333');
    expect(rgbHex(parseOpaqueColor('hsl(0.5turn 100% 50%)')!)).toBe('#00ffff');
  });

  it('does not treat translucent or gradient backgrounds as opaque', () => {
    expect(parseOpaqueColor('rgba(240, 241, 237, 0.5)')).toBeNull();
    expect(parseOpaqueColor('#aabbcc80')).toBeNull();
    expect(parseOpaqueColor('linear-gradient(white, black)')).toBeNull();
  });
});
