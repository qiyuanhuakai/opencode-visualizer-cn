export function downloadTextFile(content: string, filename: string, mimeType = 'text/plain;charset=utf-8') {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadJsonFile(data: unknown, filename: string) {
  downloadTextFile(`${JSON.stringify(data, null, 2)}\n`, filename, 'application/json;charset=utf-8');
}
