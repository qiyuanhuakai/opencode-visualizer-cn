import { describe, expect, it } from 'vitest';

import { acpBridgeWebSocketUrl, normalizeAcpBridgeUrl } from './bridgeUrl';

describe('acpBridgeWebSocketUrl', () => {
  it('reuses the VIS bridge origin, prefix, and token for an encoded agent id', () => {
    expect(
      acpBridgeWebSocketUrl(
        'wss://bridge.example.test/base?existing=1',
        'oh my/pi',
        'secret token',
      ),
    ).toBe('wss://bridge.example.test/base/acp/oh%20my%2Fpi?existing=1&token=secret+token');
  });

  it('uses IPv4 loopback for the ACP socket while keeping the stored bridge URL unchanged', () => {
    // Given: the persisted ACP bridge URL uses localhost.
    // When: the URL is normalized for storage and expanded into the live ACP socket URL.
    // Then: storage keeps localhost, while the socket dials IPv4 loopback.
    expect(normalizeAcpBridgeUrl('ws://localhost:23004')).toBe('ws://localhost:23004');
    expect(acpBridgeWebSocketUrl('ws://localhost:23004', 'oh-my-pi')).toBe(
      'ws://127.0.0.1:23004/acp/oh-my-pi',
    );
  });
});
