type Bounds = { readonly width: number; readonly height: number };
type WindowRect = Bounds & { readonly x: number; readonly y: number };

export function fitCodexCommandWindow(window: WindowRect, extent: Bounds): WindowRect {
  const margin = Math.min(16, extent.width / 4, extent.height / 4);
  const width = Math.min(window.width, Math.max(1, extent.width - margin * 2));
  const height = Math.min(window.height, Math.max(1, extent.height - margin * 2));
  return {
    width, height,
    x: Math.max(margin, Math.min(window.x, extent.width - width - margin)),
    y: Math.max(margin, Math.min(window.y, extent.height - height - margin)),
  };
}
