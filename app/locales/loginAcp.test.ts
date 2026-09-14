import { describe, expect, it } from 'vitest';

import { acpLocales, expectNonEmptyString } from './test-helpers';

const acpLoginKeys = [
  'acpTitle',
  'acpBackend',
  'acpAgentId',
  'acpBridgeHint',
  'acpBridgeUrl',
  'acpBridgeToken',
] as const;

describe('ACP login locale completeness', () => {
  it.each(acpLocales)('%s exposes every ACP login key', (_locale, messages) => {
    expectNonEmptyString(messages.app.login.acpTitle);
    expectNonEmptyString(messages.app.login.acpBackend);
    expectNonEmptyString(messages.app.login.acpAgentId);
    expectNonEmptyString(messages.app.login.acpBridgeHint);
    expectNonEmptyString(messages.app.login.acpBridgeUrl);
    expectNonEmptyString(messages.app.login.acpBridgeToken);
  });

  it('keeps the ACP login key set identical across locales', () => {
    const expectedKeys = [...acpLoginKeys].sort();
    for (const [_locale, messages] of acpLocales) {
      expect(
        Object.keys(messages.app.login)
          .filter((key) => key.startsWith('acp'))
          .sort(),
      ).toEqual(expectedKeys);
    }
  });
});
