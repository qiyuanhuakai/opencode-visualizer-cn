export function dshPermissionColor(preset: string | undefined): string {
  const token = preset === 'danger-full-access' ? 'warning' : preset === 'workspace-write' ? 'success' : 'info';
  return `color-mix(in srgb, var(--theme-status-${token}) 45%, var(--theme-input-text))`;
}
