import type { CodexSkill } from '../backends/codex/codexAdapter';

export type ParsedSkill = { name: string; path: string };

const SKILL_TOKEN = /\$\s*([A-Za-z0-9][\w-]*)/g;

export function parseSkill(
  input: string,
  skills: ReadonlyArray<CodexSkill>,
): ParsedSkill[] {
  if (!input || skills.length === 0) return [];
  const byName = new Map<string, CodexSkill>();
  for (const s of skills) byName.set(s.name, s);
  const seen = new Set<string>();
  const out: ParsedSkill[] = [];
  for (const m of input.matchAll(SKILL_TOKEN)) {
    const name = m[1];
    if (!name || seen.has(name)) continue;
    const skill = byName.get(name);
    if (!skill?.path) continue;
    seen.add(name);
    out.push({ name: skill.name, path: skill.path });
  }
  return out;
}
