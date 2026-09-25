export function isLightResolvedColor(color: string): boolean {
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/iu.exec(color);
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/iu.exec(color);
  const channels = rgb?.slice(1, 4).map(Number) ?? srgb?.slice(1, 4).map((value) => Number(value) * 255);
  if (!channels || channels.some((value) => !Number.isFinite(value))) return false;
  const [red = 0, green = 0, blue = 0] = channels;
  return red * 0.2126 + green * 0.7152 + blue * 0.0722 > 180;
}
