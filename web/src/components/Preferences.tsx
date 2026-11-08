import { useTranslation } from 'react-i18next';
import { useAuth } from '../app/auth';

/** English / বাংলা switch (UI-08). */
export function LanguageSwitch() {
  const { t } = useTranslation();
  const { language, setLanguage } = useAuth();
  return (
    <div role="group" aria-label={t('common.language')} className="segmented">
      <button type="button" aria-pressed={language === 'en'} onClick={() => setLanguage('en')} lang="en">
        English
      </button>
      <button type="button" aria-pressed={language === 'bn'} onClick={() => setLanguage('bn')} lang="bn">
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
    <div role="group" aria-label={t('common.textSize')} className="segmented">
      <button type="button" aria-pressed={!largeText} onClick={() => setLargeText(false)}>
        A <span className="sr-only">({t('common.normalText')})</span>
      </button>
      <button type="button" className="text-lg" aria-pressed={largeText} onClick={() => setLargeText(true)}>
        A+ <span className="sr-only">({t('common.largeText')})</span>
      </button>
    </div>
  );
}
