import type { DshJsonValue } from '../../backends/dsh/types';
import type { DshRpcClient } from '../../utils/dshRpc';

type LocalizedText = string | Readonly<Record<string, string>>;
export type SessionPluginRow = {
  readonly entryId: string | null;
  readonly moduleName: string;
  readonly enabled: boolean | 'conditional';
  readonly fiberPhase: string | null;
  readonly condition?: string;
  readonly title?: LocalizedText;
  readonly description?: LocalizedText;
  readonly metadataError?: string;
};
export type SessionPluginPreset = {
  readonly id: string;
  readonly name?: string;
  readonly isDefault: boolean;
  readonly broken?: string;
  readonly rows: readonly SessionPluginRow[];
};
export type SessionPluginRpc = Pick<DshRpcClient, 'call'>;
class SessionPluginInventoryError extends Error {
  constructor() { super('Invalid DSH session plugin inventory'); this.name = 'SessionPluginInventoryError'; }
}
function isObject(value: DshJsonValue | undefined): value is { readonly [key: string]: DshJsonValue } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function object(value: DshJsonValue | undefined): { readonly [key: string]: DshJsonValue } {
  if (!isObject(value)) throw new SessionPluginInventoryError();
  return value;
}
function optionalText(value: DshJsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new SessionPluginInventoryError();
  return value;
}
function localized(value: DshJsonValue | undefined): LocalizedText | undefined {
  if (value === undefined || typeof value === 'string') return value;
  const texts: Record<string, string> = {};
  for (const [key, text] of Object.entries(object(value))) {
    if (typeof text !== 'string') throw new SessionPluginInventoryError();
    texts[key] = text;
  }
  if (!texts.en) throw new SessionPluginInventoryError();
  return texts;
}
function parseRow(value: DshJsonValue): SessionPluginRow {
  const row = object(value);
  if ((row.entryId !== null && typeof row.entryId !== 'string') || typeof row.moduleName !== 'string' ||
    (typeof row.enabled !== 'boolean' && row.enabled !== 'conditional') ||
    (row.fiberPhase !== null && !['pending', 'loading', 'active', 'failed', 'unloading'].includes(String(row.fiberPhase)))) {
    throw new SessionPluginInventoryError();
  }
  const meta = row.meta === undefined ? {} : object(row.meta);
  return { entryId: row.entryId, moduleName: row.moduleName, enabled: row.enabled,
    fiberPhase: row.fiberPhase === null ? null : String(row.fiberPhase), condition: optionalText(row.condition),
    title: localized(meta.title), description: localized(meta.description), metadataError: optionalText(meta.error) };
}
export async function readSessionPluginPresets(rpc: SessionPluginRpc): Promise<readonly SessionPluginPreset[]> {
  const inventory = object(await rpc.call('pluginInventory', 'list', {}));
  if (inventory.agentPresets === undefined) return [];
  if (!Array.isArray(inventory.agentPresets)) throw new SessionPluginInventoryError();
  return inventory.agentPresets.map((value) => {
    const preset = object(value);
    if (typeof preset.id !== 'string' || typeof preset.isDefault !== 'boolean' || !Array.isArray(preset.rows)) throw new SessionPluginInventoryError();
    return { id: preset.id, name: optionalText(preset.name), isDefault: preset.isDefault,
      broken: optionalText(preset.broken), rows: preset.rows.map(parseRow) };
  });
}
export function sessionPluginText(text: LocalizedText | undefined, locale: string): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  return text[locale.toLowerCase()] ?? text[locale.split('-')[0] ?? 'en'] ?? text.en ?? '';
}
