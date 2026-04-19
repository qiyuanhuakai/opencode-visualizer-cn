import { createI18n } from 'vue-i18n';
import en from '../locales/en';
import zhCN from '../locales/zh-CN';
import zhTW from '../locales/zh-TW';
import ja from '../locales/ja';
import { storageGet, storageSet, storageKey } from '../utils/storageKeys';
import type { Locale } from './types';

const LOCALE_STORAGE_KEY = 'settings.locale.v1';
const DEFAULT_LOCALE: Locale = 'en';
const VALID_LOCALES: Locale[] = ['en', 'zh-CN', 'zh-TW', 'ja'];

export function getStoredLocale(): Locale {
  const stored = storageGet(LOCALE_STORAGE_KEY);
  if (stored && (VALID_LOCALES as string[]).includes(stored)) {
    return stored as Locale;
  }
  return DEFAULT_LOCALE;
}

export function setStoredLocale(locale: Locale) {
  storageSet(LOCALE_STORAGE_KEY, locale);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const i18n = createI18n<any>({
  legacy: false,
  locale: getStoredLocale(),
  fallbackLocale: 'en',
  messages: {
    en,
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    ja,
  },
});

export function setLocale(locale: Locale) {
  // @ts-expect-error - locale is writable
  i18n.global.locale.value = locale;
  setStoredLocale(locale);
}

export function getLocale(): Locale {
  // @ts-expect-error - locale has value property
  return i18n.global.locale.value as Locale;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey(LOCALE_STORAGE_KEY)) {
      const newLocale = event.newValue as Locale | null;
      if (newLocale && (VALID_LOCALES as string[]).includes(newLocale)) {
        // @ts-expect-error - locale is writable
        i18n.global.locale.value = newLocale;
      }
    }
  });
}

export default i18n;
