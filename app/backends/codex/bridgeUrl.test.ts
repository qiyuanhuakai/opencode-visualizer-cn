import { describe, expect, it } from 'vitest';
import { appendCodexBridgeToken, codexBridgeHttpUrl } from './bridgeUrl';

describe('Codex bridge URL helpers', () => {
  it('appends bridge tokens without dropping existing query values', () => {
    expect(appendCodexBridgeToken('ws://host:23004/codex?mode=remote', 'secret')).toBe(
      'ws://host:23004/codex?mode=remote&token=secret',
    );
  });

  it('derives homedir URL from bridge origin with matching transport security', () => {
    expect(codexBridgeHttpUrl('ws://host:23004/codex?token=secret', '/homedir')).toBe(
      'http://host:23004/homedir?token=secret',
    );
    expect(codexBridgeHttpUrl('wss://host.example/bridge/codex?token=secret', '/homedir')).toBe(
      'https://host.example/bridge/homedir?token=secret',
    );
  });
});
