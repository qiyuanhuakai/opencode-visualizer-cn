export type LegacyPiece = Readonly<{ key: string; source: string; namespace: string; content: string; end: boolean; authority?: string }>;
export type LegacySource = () => AsyncIterable<LegacyPiece>;
export type LegacyExportToken = Readonly<{ version: 1; revision: string; offset: number; count: number; records: number; exportableRecords: number; localOnlyRecords: number }>;
export type LegacyExportChunk = Readonly<{ source: string; sourceKey: string; namespace: string; ownership: 'unattached-legacy-local'; authority: string; offset: number; content: string; end: boolean; checksum: string }>;
export type LegacyExportPage = Readonly<{ revision: string; chunks: readonly LegacyExportChunk[]; next: LegacyExportToken | null }>;
export type LegacyPageRequest = Readonly<{ token: LegacyExportToken; limit?: number }>;
export function legacyDigest(text: string): Promise<string>;
export function isLocalCredential(key: string): boolean;
export function openLegacyExport(source: LegacySource): Promise<LegacyExportToken>;
export function readLegacyExportPage(source: LegacySource, request: LegacyPageRequest): Promise<LegacyExportPage>;

export function resolveLegacyLocalBinding(source: LegacySource, sourceKey: string): Promise<Readonly<{ key: string; source: string; namespace: string }>>;
