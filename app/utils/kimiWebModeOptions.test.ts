import { createI18n } from 'vue-i18n';
import { describe, expect, it } from 'vitest';
import en from '../locales/en';
import { kimiWebAgentModeOptions } from './kimiWebModeOptions';

const composerMessages = { en: { kimiWeb: { composer: en.kimiWeb.composer } } };

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  missingWarn: false,
  fallbackWarn: false,
  messages: composerMessages,
});

function translate(key: string): string {
  const translated = i18n.global.t(key);
  expect(typeof translated, `expected ${key} to resolve to a string`).toBe('string');
  return translated as string;
}

describe('kimiWebAgentModeOptions', () => {
  it('returns manual auto yolo and no toggle modes', () => {
    const options = kimiWebAgentModeOptions();

    // Exactly the three kimi wire permission modes, in this order.
    expect(options.map((option) => option.id)).toEqual(['manual', 'auto', 'yolo']);
    expect(options).toHaveLength(3);

    // Wire ids stay untranslated, lowercase, and free of the plan/default toggle modes.
    for (const option of options) {
      expect(option.id).toMatch(/^[a-z]+$/);
      expect(option.id).not.toBe('plan');
      expect(option.id).not.toBe('default');
    }

    expect(options.map((option) => option.labelKey)).toEqual([
      'kimiWeb.composer.manual',
      'kimiWeb.composer.auto',
      'kimiWeb.composer.yolo',
    ]);
    expect(options.map((option) => option.descriptionKey)).toEqual([
      'kimiWeb.composer.manualDescription',
      'kimiWeb.composer.autoDescription',
      'kimiWeb.composer.yoloDescription',
    ]);

    // Every referenced key resolves to a real, non-empty English string.
    for (const option of options) {
      const label = translate(option.labelKey);
      const description = translate(option.descriptionKey);
      expect(label, `${option.labelKey} must resolve to a non-empty en string`).not.toBe('');
      expect(label, `${option.labelKey} must exist in en`).not.toBe(option.labelKey);
      expect(description, `${option.descriptionKey} must resolve to a non-empty en string`).not.toBe('');
      expect(description, `${option.descriptionKey} must exist in en`).not.toBe(option.descriptionKey);
    }
  });
});
