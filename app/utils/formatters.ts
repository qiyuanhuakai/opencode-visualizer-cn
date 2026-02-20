export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function contextSeverityClass(percent: number): string {
  if (percent >= 90) return 'ib-ctx-critical';
  if (percent >= 75) return 'ib-ctx-high';
  if (percent >= 50) return 'ib-ctx-moderate';
  return 'ib-ctx-low';
}

export function formatMessageTime(value?: number): string {
  if (typeof value !== 'number') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function formatMessageError(error: { name: string; message: string }): string {
  if (error.name === 'MessageAbortedError') return error.message || 'Aborted';
  const parts: string[] = [];
  if (error.name) parts.push(error.name);
  if (error.message) parts.push(error.message);
  return parts.join(': ') || 'Error';
}

export function formatElapsedTime(startMs?: number, endMs?: number): string {
  if (typeof startMs !== 'number' || typeof endMs !== 'number') return '';
  const sec = Math.round((endMs - startMs) / 1000);
  if (sec < 1) return '';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}m${rem}s` : `${min}m`;
}
