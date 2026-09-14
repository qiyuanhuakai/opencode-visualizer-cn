import type { Ref } from 'vue';
import type { ConnectionErrorPacket } from '../types/sse';

type UiInitState = 'loading' | 'ready' | 'error' | 'login';
type ConnectionState = 'connecting' | 'bootstrapping' | 'ready' | 'reconnecting' | 'error';

export type BackendAuthFailureHandlerOptions = {
  readonly uiInitState: Ref<UiInitState>;
  readonly initErrorMessage: Ref<string>;
  readonly connectionState: Ref<ConnectionState>;
  readonly reconnectingMessage: Ref<string>;
  readonly abortInitialization: () => void;
  readonly persistAuthError: (message: string) => void;
  readonly clearCredentials: () => void;
  readonly translate: (key: string) => string;
};

export function createBackendAuthFailureHandler(
  options: BackendAuthFailureHandlerOptions,
): (payload: ConnectionErrorPacket) => void {
  return (payload) => {
    if (payload.statusCode === 401 || payload.statusCode === 403) {
      const message = `${payload.message} (HTTP ${payload.statusCode})`;
      options.abortInitialization();
      options.persistAuthError(message);
      options.clearCredentials();
      options.uiInitState.value = 'login';
      options.initErrorMessage.value = message;
      options.connectionState.value = 'error';
      return;
    }
    if (options.uiInitState.value === 'loading') {
      options.connectionState.value = 'error';
      options.initErrorMessage.value = options.translate('app.errors.sseConnectFailed');
      options.uiInitState.value = 'login';
      return;
    }
    options.connectionState.value = 'reconnecting';
    options.reconnectingMessage.value = options.translate('app.connection.reconnecting');
  };
}
