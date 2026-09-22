import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useMessageCacheAuthInvalidation } from './useMessageCacheAuthInvalidation';

function createFixture() {
  const username = ref('user-a');
  const codexBridgeToken = ref('codex-a');
  const acpBridgeToken = ref('acp-a');
  const kimiWebBridgeToken = ref('kimi-a');
  const messageCacheAuthGeneration = ref(4);
  const sessionReloadRequestId = ref(8);
  const clearSessionCache = vi.fn();
  const invalidateMessageCacheContext = vi.fn();
  const dispose = useMessageCacheAuthInvalidation({
    authHeader: computed(() => (username.value ? `Basic ${username.value}` : undefined)),
    codexBridgeToken,
    acpBridgeToken,
    kimiWebBridgeToken,
    messageCacheAuthGeneration,
    sessionReloadRequestId,
    clearSessionCache,
    invalidateMessageCacheContext,
  });

  return {
    username,
    codexBridgeToken,
    acpBridgeToken,
    messageCacheAuthGeneration,
    sessionReloadRequestId,
    clearSessionCache,
    invalidateMessageCacheContext,
    dispose,
  };
}

describe('useMessageCacheAuthInvalidation', () => {
  it.each([
    [
      'OpenCode authorization',
      (fixture: ReturnType<typeof createFixture>) => {
        fixture.username.value = 'user-b';
      },
    ],
    [
      'Codex bridge token',
      (fixture: ReturnType<typeof createFixture>) => {
        fixture.codexBridgeToken.value = 'codex-b';
      },
    ],
    [
      'ACP bridge token',
      (fixture: ReturnType<typeof createFixture>) => {
        fixture.acpBridgeToken.value = 'acp-b';
      },
    ],
  ])(
    'Given a warm message cache, When the %s changes, Then all invalidation effects run synchronously',
    (_credential, changeCredential) => {
      const fixture = createFixture();

      changeCredential(fixture);

      expect(fixture.messageCacheAuthGeneration.value).toBe(5);
      expect(fixture.sessionReloadRequestId.value).toBe(9);
      expect(fixture.clearSessionCache).toHaveBeenCalledOnce();
      expect(fixture.invalidateMessageCacheContext).toHaveBeenCalledOnce();
      fixture.dispose();
    },
  );

  it('Given registered credential watchers, When values stay unchanged, Then no invalidation effect runs', () => {
    const fixture = createFixture();

    fixture.username.value = 'user-a';
    fixture.codexBridgeToken.value = 'codex-a';
    fixture.acpBridgeToken.value = 'acp-a';

    expect(fixture.messageCacheAuthGeneration.value).toBe(4);
    expect(fixture.sessionReloadRequestId.value).toBe(8);
    expect(fixture.clearSessionCache).not.toHaveBeenCalled();
    expect(fixture.invalidateMessageCacheContext).not.toHaveBeenCalled();
    fixture.dispose();
  });

  it('Given disposed credential watchers, When every credential changes, Then no invalidation effect runs', () => {
    const fixture = createFixture();
    fixture.dispose();

    fixture.username.value = 'user-b';
    fixture.codexBridgeToken.value = 'codex-b';
    fixture.acpBridgeToken.value = 'acp-b';

    expect(fixture.messageCacheAuthGeneration.value).toBe(4);
    expect(fixture.sessionReloadRequestId.value).toBe(8);
    expect(fixture.clearSessionCache).not.toHaveBeenCalled();
    expect(fixture.invalidateMessageCacheContext).not.toHaveBeenCalled();
  });
});

// R8/S5c: kimiWebBridgeToken is missing from the invalidation watcher, so a kimi-web
// session loaded under token A survives in the message cache after the token changes.
describe('kimi-web bridge token invalidates the message cache (R8/S5c)', () => {
  function createKimiWebFixture() {
    const username = ref('user-a');
    const codexBridgeToken = ref('codex-a');
    const acpBridgeToken = ref('acp-a');
    const kimiWebBridgeToken = ref('kimi-a');
    const messageCacheAuthGeneration = ref(4);
    const sessionReloadRequestId = ref(8);
    const clearSessionCache = vi.fn();
    const invalidateMessageCacheContext = vi.fn();
    // Bound to a local first so RED stays a runtime assertion failure rather than a
    // type error until kimiWebBridgeToken is added to the options type in Wave 2.
    const invalidationOptions = {
      authHeader: computed(() => (username.value ? `Basic ${username.value}` : undefined)),
      codexBridgeToken,
      acpBridgeToken,
      kimiWebBridgeToken,
      messageCacheAuthGeneration,
      sessionReloadRequestId,
      clearSessionCache,
      invalidateMessageCacheContext,
    };
    const dispose = useMessageCacheAuthInvalidation(invalidationOptions);

    return {
      username,
      codexBridgeToken,
      acpBridgeToken,
      kimiWebBridgeToken,
      messageCacheAuthGeneration,
      sessionReloadRequestId,
      clearSessionCache,
      invalidateMessageCacheContext,
      dispose,
    };
  }

  it('Given a warm message cache, When the Kimi Web bridge token changes, Then all invalidation effects run synchronously', () => {
    const fixture = createKimiWebFixture();

    fixture.kimiWebBridgeToken.value = 'kimi-b';

    expect(
      fixture.messageCacheAuthGeneration.value,
      'changing the Kimi Web bridge token must bump the message cache auth generation (R8/S5c)',
    ).toBe(5);
    expect(fixture.sessionReloadRequestId.value).toBe(9);
    expect(fixture.clearSessionCache).toHaveBeenCalledOnce();
    expect(fixture.invalidateMessageCacheContext).toHaveBeenCalledOnce();
    fixture.dispose();
  });
});
