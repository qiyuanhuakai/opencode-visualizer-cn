export type ShellWindowSize = {
  readonly width: number;
  readonly height: number;
};

export function clampShellWindowSize(size: ShellWindowSize, minimum?: ShellWindowSize): ShellWindowSize {
  if (!minimum) return size;
  return {
    width: Math.max(size.width, minimum.width),
    height: Math.max(size.height, minimum.height),
  };
}
