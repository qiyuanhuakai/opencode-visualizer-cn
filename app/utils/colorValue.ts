export type RgbColor = readonly [number, number, number];

function channel(value: string): number | null {
  const percent = value.endsWith('%');
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return null;
  const scaled = percent ? number * 2.55 : number;
  if (scaled < 0 || scaled > 255) return null;
  return Math.round(scaled);
}

function opaqueAlpha(value: string | undefined): boolean {
  if (value === undefined) return true;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && (value.endsWith('%') ? number === 100 : number === 1);
}

function hueDegrees(value: string): number {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return Number.NaN;
  if (value.endsWith('turn')) return number * 360;
  if (value.endsWith('grad')) return number * 0.9;
  if (value.endsWith('rad')) return number * 180 / Math.PI;
  if (value.endsWith('deg') || /^[-+]?\d+(?:\.\d+)?$/.test(value)) return number;
  return Number.NaN;
}

export function parseOpaqueColor(value: string | null | undefined): RgbColor | null {
  if (!value) return null;
  const input = value.trim();
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(input)?.[1];
  if (hex) {
    if (hex.length === 4 && hex[3].toLowerCase() !== 'f') return null;
    if (hex.length === 8 && hex.slice(6).toLowerCase() !== 'ff') return null;
    const digits = hex.length <= 4
      ? hex.slice(0, 3).split('').map((digit) => digit + digit)
      : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
    return digits.map((digits) => Number.parseInt(digits, 16)) as unknown as RgbColor;
  }

  const rgb = /^rgba?\((.+)\)$/i.exec(input);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4 || !opaqueAlpha(parts[3])) return null;
    const channels = parts.slice(0, 3).map(channel);
    return channels.every((value) => value !== null)
      ? [channels[0]!, channels[1]!, channels[2]!]
      : null;
  }

  const hsl = /^hsla?\((.+)\)$/i.exec(input);
  if (hsl) {
    const parts = hsl[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4 || !opaqueAlpha(parts[3])) return null;
    const hue = hueDegrees(parts[0]);
    const saturation = Number.parseFloat(parts[1]);
    const lightness = Number.parseFloat(parts[2]);
    if (!Number.isFinite(hue) || !parts[1].endsWith('%') || !parts[2].endsWith('%')
      || saturation < 0 || saturation > 100 || lightness < 0 || lightness > 100) return null;
    const s = saturation / 100;
    const l = lightness / 100;
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const unit = ((hue % 360) + 360) % 360 / 60;
    const secondary = chroma * (1 - Math.abs(unit % 2 - 1));
    const [red, green, blue] = unit < 1 ? [chroma, secondary, 0]
      : unit < 2 ? [secondary, chroma, 0]
        : unit < 3 ? [0, chroma, secondary]
          : unit < 4 ? [0, secondary, chroma]
            : unit < 5 ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
    const offset = l - chroma / 2;
    return [
      Math.round((red + offset) * 255),
      Math.round((green + offset) * 255),
      Math.round((blue + offset) * 255),
    ];
  }
  return null;
}

export function rgbHex([red, green, blue]: RgbColor): string {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}
