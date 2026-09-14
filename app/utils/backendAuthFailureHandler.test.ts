import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createBackendAuthFailureHandler } from './backendAuthFailureHandler';

function createFixture(uiState: 'loading' | 'ready' = 'ready') {
  const events: string[] = [];
  const uiInitState = ref<'loading' | 'ready' | 'error' | 'login'>(uiState);
  const initErrorMessage = ref('');
  const connectionState = ref<'connecting' | 'bootstrapping' | 'ready' | 'reconnecting' | 'error'>(
    'ready',
  );
  const reconnectingMessage = ref('');
  const abortInitialization = vi.fn(() => events.push('abort'));
  const persistAuthError = vi.fn(() => events.push('persist'));
  const clearCredentials = vi.fn(() => events.push('clear'));
  const handler = createBackendAuthFailureHandler({
    uiInitState,
    initErrorMessage,
    connectionState,
    reconnectingMessage,
    abortInitialization,
    persistAuthError,
    clearCredentials,
    translate: (key) => `translated:${key}`,
  });

  return {
    events,
    uiInitState,
    initErrorMessage,
    connectionState,
    reconnectingMessage,
    abortInitialization,
    persistAuthError,
    clearCredentials,
    handler,
  };
}

describe('createBackendAuthFailureHandler', () => {
  it.each([401, 403])(
    'Given backend initialization is active, When HTTP %s arrives, Then startup aborts before credentials are cleared',
    (statusCode) => {
      const fixture = createFixture('loading');

      fixture.handler({ message: 'Authentication rejected', statusCode });

      const message = `Authentication rejected (HTTP ${statusCode})`;
      expect(fixture.events).toEqual(['abort', 'persist', 'clear']);
      expect(fixture.persistAuthError).toHaveBeenCalledWith(message);
      expect(fixture.uiInitState.value).toBe('login');
      expect(fixture.initErrorMessage.value).toBe(message);
      expect(fixture.connectionState.value).toBe('error');
    },
  );

  it('Given initialization is loading, When a non-auth connection error arrives, Then the existing login error behavior is preserved', () => {
    const fixture = createFixture('loading');

    fixture.handler({ message: 'network unavailable', statusCode: 500 });

    expect(fixture.abortInitialization).not.toHaveBeenCalled();
    expect(fixture.clearCredentials).not.toHaveBeenCalled();
    expect(fixture.connectionState.value).toBe('error');
    expect(fixture.initErrorMessage.value).toBe('translated:app.errors.sseConnectFailed');
    expect(fixture.uiInitState.value).toBe('login');
  });

  it('Given the App is ready, When a non-auth connection error arrives, Then reconnect behavior is preserved', () => {
    const fixture = createFixture('ready');

    fixture.handler({ message: 'network unavailable' });

    expect(fixture.abortInitialization).not.toHaveBeenCalled();
    expect(fixture.clearCredentials).not.toHaveBeenCalled();
    expect(fixture.connectionState.value).toBe('reconnecting');
    expect(fixture.reconnectingMessage.value).toBe('translated:app.connection.reconnecting');
    expect(fixture.uiInitState.value).toBe('ready');
  });
});
