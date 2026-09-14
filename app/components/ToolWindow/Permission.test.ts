import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App as VueApp } from 'vue';
import { createI18n } from 'vue-i18n';

import en from '../../locales/en';
import Permission from './Permission.vue';

const apps: VueApp[] = [];

type PermissionRequest = InstanceType<typeof Permission>['$props']['request'];

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.replaceChildren();
});

function mountPermission(request: PermissionRequest, onReply = vi.fn()) {
  const target = document.createElement('div');
  document.body.append(target);
  const app = createApp(Permission, { request, onReply });
  apps.push(app);
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(target);
  return { onReply, target };
}

function permissionRequest(always: string[]): PermissionRequest {
  return {
    id: 'request-1',
    sessionID: 'session-1',
    permission: 'Run command',
    patterns: [],
    metadata: {},
    always,
    tool: { messageID: 'assistant-1', callID: 'tool-1' },
  };
}

describe('Permission window', () => {
  it('hides the Always action when the request has no always choices', () => {
    // Given: a mounted permission request with no always choices.
    // When: the Permission window renders.
    const { target } = mountPermission(permissionRequest([]));

    // Then: the Always action is absent.
    expect(target.querySelector<HTMLButtonElement>('.permission-button.is-always')).toBeNull();
  });

  it('emits an Always reply payload when the request exposes always choices', () => {
    // Given: a mounted permission request with an always choice.
    const onReply = vi.fn();
    const { target } = mountPermission(permissionRequest(['*']), onReply);

    // When: the Always action is clicked.
    target.querySelector<HTMLButtonElement>('.permission-button.is-always')?.click();

    // Then: the component emits the reply payload consumed by permission handling.
    expect(onReply).toHaveBeenCalledExactlyOnceWith({
      requestId: 'request-1',
      reply: 'always',
    });
  });
});
