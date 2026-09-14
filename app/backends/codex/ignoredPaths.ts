const gitPathEscapes: Record<string, string> = {
  a: '\x07',
  b: '\b',
  t: '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
};

export function parseIgnoredPaths(output: string): Set<string> {
  return new Set(
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        if (!line.startsWith('"') || !line.endsWith('"')) return line;
        return line.slice(1, -1).replace(/\\([0-7]{1,3}|.)/gu, (_, escape: string) => {
          if (/^[0-7]+$/u.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
          return gitPathEscapes[escape] ?? escape;
        });
      }),
  );
}
