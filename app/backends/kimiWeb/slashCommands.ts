import type { KimiWebPermissionMode } from './sessionModes';

export type KimiWebSlashAction =
  | { readonly kind: 'permission'; readonly mode: KimiWebPermissionMode }
  | { readonly kind: 'toggle'; readonly field: 'planMode' | 'swarmMode' | 'towerMode'; readonly value?: boolean }
  | { readonly kind: 'compact' }
  | { readonly kind: 'help' };

export const KIMI_WEB_SLASH_COMMANDS = [
  { name: 'help', descriptionKey: 'kimiWeb.commands.help', usage: '/help' },
  { name: 'manual', descriptionKey: 'kimiWeb.composer.manualDescription', usage: '/manual' },
  { name: 'yolo', descriptionKey: 'kimiWeb.composer.yoloDescription', usage: '/yolo' },
  { name: 'auto', descriptionKey: 'kimiWeb.composer.autoDescription', usage: '/auto' },
  { name: 'plan', descriptionKey: 'kimiWeb.composer.planDescription', usage: '/plan [on|off]' },
  { name: 'swarm', descriptionKey: 'kimiWeb.composer.swarmDescription', usage: '/swarm [on|off]' },
  { name: 'tower', descriptionKey: 'kimiWeb.composer.towerDescription', usage: '/tower on|off' },
  { name: 'compact', descriptionKey: 'kimiWeb.commands.compact', usage: '/compact' },
] as const;

export class KimiWebSlashCommandError extends Error {
  constructor(readonly command: string, readonly usage?: string) {
    super(usage ? `Usage: ${usage}` : `Unsupported Kimi Web command: /${command}. Use /help.`);
    this.name = 'KimiWebSlashCommandError';
  }
}

export function parseKimiWebSlashCommand(input: string): KimiWebSlashAction | null {
  const text = input.trim();
  if (!text.startsWith('/')) return null;
  const [rawName = '', ...args] = text.slice(1).split(/\s+/u);
  const name = rawName.toLowerCase();
  const command = KIMI_WEB_SLASH_COMMANDS.find((item) => item.name === name);
  if (!command) throw new KimiWebSlashCommandError(name);
  const argument = args.join(' ').toLowerCase();
  switch (name) {
    case 'manual': case 'yolo': case 'auto':
      if (argument) throw new KimiWebSlashCommandError(name, command.usage);
      return { kind: 'permission', mode: name };
    case 'help': case 'compact':
      if (argument) throw new KimiWebSlashCommandError(name, command.usage);
      return { kind: name };
    case 'plan': case 'swarm': case 'tower':
      if ((argument && argument !== 'on' && argument !== 'off') || (!argument && name === 'tower')) {
        throw new KimiWebSlashCommandError(name, command.usage);
      }
      return { kind: 'toggle', field: name === 'plan' ? 'planMode' : name === 'swarm' ? 'swarmMode' : 'towerMode', value: argument ? argument === 'on' : undefined };
    default: throw new KimiWebSlashCommandError(name);
  }
}
