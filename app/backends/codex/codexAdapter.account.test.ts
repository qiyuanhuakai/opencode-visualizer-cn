import { afterEach, describe, expect, it } from 'vitest';
import { createCodexAdapter } from './codexAdapter';
import {
  closeCodexTestSockets,
  CodexTestSocket as MockWebSocket,
  waitForSent,
} from './codexTestSocket';

describe('CodexAdapter', () => {
  afterEach(closeCodexTestSockets);

  describe('CodexAdapter extended APIs', () => {
    it('reads account info', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const account = adapter.readAccount({ refreshToken: false });
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, {
        account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
        requiresOpenaiAuth: true,
      });

      await expect(account).resolves.toEqual({
        account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
        requiresOpenaiAuth: true,
      });
      expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
        id: 2,
        method: 'account/read',
        params: { refreshToken: false },
      });
    });

    it('starts account login with API key', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const login = adapter.startAccountLogin({
        type: 'apiKey',
        apiKey: 'sk-test123',
      });
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, { type: 'apiKey' });

      await expect(login).resolves.toEqual({ type: 'apiKey' });
      expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
        id: 2,
        method: 'account/login/start',
        params: { type: 'apiKey', apiKey: 'sk-test123' },
      });
    });

    it('starts account login with ChatGPT browser flow', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const login = adapter.startAccountLogin({ type: 'chatgpt' });
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, {
        type: 'chatgpt',
        loginId: 'login-123',
        authUrl: 'https://chatgpt.com/auth?...',
      });

      await expect(login).resolves.toEqual({
        type: 'chatgpt',
        loginId: 'login-123',
        authUrl: 'https://chatgpt.com/auth?...',
      });
      expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
        id: 2,
        method: 'account/login/start',
        params: { type: 'chatgpt' },
      });
    });

    it('starts account login with device code', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const login = adapter.startAccountLogin({
        type: 'chatgptDeviceCode',
      });
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, {
        type: 'chatgptDeviceCode',
        loginId: 'login-456',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
      });

      await expect(login).resolves.toEqual({
        type: 'chatgptDeviceCode',
        loginId: 'login-456',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
      });
      expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
        id: 2,
        method: 'account/login/start',
        params: { type: 'chatgptDeviceCode' },
      });
    });

    it('cancels a pending login', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const cancel = adapter.cancelAccountLogin({ loginId: 'login-123' });
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, {});

      await expect(cancel).resolves.toEqual({});
      expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
        id: 2,
        method: 'account/login/cancel',
        params: { loginId: 'login-123' },
      });
    });

    it('logs out', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const logout = adapter.logoutAccount();
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, {});

      await expect(logout).resolves.toEqual({});
      expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
        id: 2,
        method: 'account/logout',
        params: {},
      });
    });

    it('reads account rate limits', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const rateLimits = adapter.readAccountRateLimits();
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, {
        rateLimits: {
          limitId: 'codex',
          primary: {
            usedPercent: 25,
            windowDurationMins: 15,
            resetsAt: 1730947200,
          },
          secondary: null,
          rateLimitReachedType: null,
        },
      });

      await expect(rateLimits).resolves.toEqual({
        rateLimits: {
          limitId: 'codex',
          primary: {
            usedPercent: 25,
            windowDurationMins: 15,
            resetsAt: 1730947200,
          },
          secondary: null,
          rateLimitReachedType: null,
        },
      });
      expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
        id: 2,
        method: 'account/rateLimits/read',
        params: {},
      });
    });
  });
});
