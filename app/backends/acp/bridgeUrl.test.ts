import { describe, expect, it } from 'vitest';

import { acpBridgeWebSocketUrl } from './bridgeUrl';

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
});
