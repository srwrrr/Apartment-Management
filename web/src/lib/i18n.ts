import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@apt/shared/src/locales/en.json';
import bn from '@apt/shared/src/locales/bn.json';

export type Lang = 'en' | 'bn';

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode or blocked storage: the app must still work
  }
}
export function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function safeRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function initialLanguage(): Lang {
  const saved = safeGet('lang');
  if (saved === 'en' || saved === 'bn') return saved;
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('bn') ? 'bn' : 'en';
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, bn: { translation: bn } },
  lng: initialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
});

export const currentLang = (): Lang => (i18n.language === 'bn' ? 'bn' : 'en');
export default i18n;
