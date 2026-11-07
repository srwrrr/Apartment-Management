import { useTranslation } from 'react-i18next';
import { useAuth } from '../app/auth';

const seg = (on: boolean) =>
  `min-h-11 min-w-11 px-3 text-base font-semibold first:rounded-l-lg last:rounded-r-lg border border-line ${on ? 'bg-brand-600 text-white' : 'bg-white text-ink hover:bg-brand-50'}`;

/** English / বাংলা switch (UI-08). */
export function LanguageSwitch() {
  const { t } = useTranslation();
  const { language, setLanguage } = useAuth();
  return (
    <div role="group" aria-label={t('common.language')} className="inline-flex">
      <button type="button" className={seg(language === 'en')} aria-pressed={language === 'en'} onClick={() => setLanguage('en')} lang="en">
        English
      </button>
      <button type="button" className={seg(language === 'bn')} aria-pressed={language === 'bn'} onClick={() => setLanguage('bn')} lang="bn">
        বাংলা
      </button>
    </div>
  );
}

/** A / A+ text-size switch (UI-10, FR-55). */
export function TextSizeSwitch() {
  const { t } = useTranslation();
  const { largeText, setLargeText } = useAuth();
  return (
    <div role="group" aria-label={t('common.textSize')} className="inline-flex">
      <button type="button" className={seg(!largeText)} aria-pressed={!largeText} onClick={() => setLargeText(false)}>
        A <span className="sr-only">({t('common.normalText')})</span>
      </button>
      <button type="button" className={`${seg(largeText)} text-xl`} aria-pressed={largeText} onClick={() => setLargeText(true)}>
        A+ <span className="sr-only">({t('common.largeText')})</span>
      </button>
    </div>
  );
}
