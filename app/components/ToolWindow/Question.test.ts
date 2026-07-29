import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageKeys, storageGetJSON } from '../../utils/storageKeys';
import Question from './Question.vue';

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('Question', () => {
  it('renders secret answers as passwords and excludes them from persisted drafts', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    const app = createApp(Question, {
      request: {
        id: 'secret-request',
        sessionID: 'thread-1',
        questions: [{
          header: 'API key',
          question: 'Enter the API key',
          options: [],
          custom: true,
          secret: true,
        }],
      },
    });
    app.use(createI18n({
      legacy: false,
      locale: 'en',
      messages: {
        en: {
          toolWindow: {
            question: {
              title: 'Question',
              itemCount: '{count}',
              session: 'Session',
              modeSingle: 'Single',
              customAnswer: 'Answer',
              reject: 'Reject',
              reply: 'Reply',
            },
          },
        },
      },
    }));
    app.mount(target);
    await nextTick();

    const input = target.querySelector<HTMLInputElement>('input[type="password"]');
    if (!input) throw new Error('Secret answer input missing.');
    input.value = 'top-secret';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    app.unmount();

    expect(storageGetJSON(StorageKeys.drafts.question)).toEqual({
      'secret-request': { selectedAnswers: [[]], customAnswers: [''] },
    });
  });
});
