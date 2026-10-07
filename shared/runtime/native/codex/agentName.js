export function codexAgentName(path) {
  return path.split('/').filter(Boolean).at(-1) || path;
}
