export type RestoredPtyKind = 'forge' | 'shell';

export function resolveRestoredPtyKind(ptyId: string, forgePtyId: string): RestoredPtyKind {
  return ptyId === forgePtyId && forgePtyId.length > 0 ? 'forge' : 'shell';
}
