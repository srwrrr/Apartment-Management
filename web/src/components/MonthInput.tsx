import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { currentLang } from '../lib/i18n';
import { monthLabel, thisMonth } from '../lib/format';

const VALID = /^\d{4}-(0[1-9]|1[0-2])$/;
const pad = (m: number) => String(m).padStart(2, '0');

type Props = {
  id?: string;
  value: string;
  /** Same shape as a native input's change event, so callers read e.target.value as before. */
  onChange: (e: { target: { value: string } }) => void;
  required?: boolean;
  disabled?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
};

/**
 * A month field ('YYYY-MM') with a calendar that works in every browser.
 * <input type="month"> is plain text in Firefox and desktop Safari, so it cannot be relied on.
 * The box still takes typing (YYYY-MM); the button opens a month grid.
 */
export function MonthInput({ value, onChange, required, disabled, ...field }: Props) {
  const { t } = useTranslation();
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<string | null>(null); // what is being typed, until the box loses focus
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ end: false });
  const base = VALID.test(value) ? value : thisMonth();
  const [year, setYear] = useState(Number(base.slice(0, 4)));
  const [active, setActive] = useState(Number(base.slice(5, 7)));
  const [moveFocus, setMoveFocus] = useState(false);

  const emit = (v: string) => onChange({ target: { value: v } });

  const show = (focusGrid: boolean) => {
    const b = VALID.test(value) ? value : thisMonth();
    setYear(Number(b.slice(0, 4)));
    setActive(Number(b.slice(5, 7)));
    const r = wrap.current!.getBoundingClientRect();
    // Always below the field (the page or dialog scrolls to show it); from the right edge when it would run off the screen.
    setPlace({ end: r.left + 288 > window.innerWidth - 8 });
    setMoveFocus(focusGrid);
    setOpen(true);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const pick = (m: number) => {
    emit(`${year}-${pad(m)}`);
    close(true);
  };

  // Whatever does not fit is scrolled into view (a dialog scrolls itself, the page scrolls otherwise).
  useLayoutEffect(() => {
    if (!open) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    wrap.current?.querySelector('[role="dialog"]')?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [open]);

  // Keyboard focus follows the highlighted month.
  useLayoutEffect(() => {
    if (!open || !moveFocus) return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-month="${active}"]`)?.focus({ preventScroll: true });
  }, [open, moveFocus, active, year]);

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Escape closes the calendar only, not a dialog it sits in.
  useEffect(() => {
    const node = wrap.current!;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.stopPropagation();
        close(true);
      }
    };
    node.addEventListener('keydown', onKey);
    return () => node.removeEventListener('keydown', onKey);
  }, [open]);

  const onGridKey = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      let m = active + step;
      let y = year;
      if (m < 1) { m += 12; y -= 1; }
      if (m > 12) { m -= 12; y += 1; }
      setYear(y);
      setActive(m);
      setMoveFocus(true);
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      setYear((y) => y + (e.key === 'PageUp' ? -1 : 1));
      setMoveFocus(true);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 1 : 12);
      setMoveFocus(true);
    }
  };

  const locale = currentLang() === 'bn' ? 'bn-BD-u-nu-latn' : 'en-GB';
  const names = Array.from({ length: 12 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, i, 1))),
  );
  const today = thisMonth();
  const shown = draft ?? (VALID.test(value) ? monthLabel(value) : value);
  const popId = `${field.id ?? 'month'}-calendar`;

  return (
    <div
      ref={wrap}
      className="relative"
      onBlur={(e) => {
        if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        {...field}
        ref={input}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={t('picker.monthFormat')}
        required={required}
        disabled={disabled}
        value={shown}
        className="field pe-12"
        onBlur={() => setDraft(null)}
        onClick={() => !open && show(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && (e.altKey || !open)) {
            e.preventDefault();
            show(true);
          }
        }}
        onChange={(e) => {
          const v = e.target.value.trim();
          setDraft(e.target.value);
          if (VALID.test(v) || (v === '' && !required)) emit(v);
        }}
      />
      <button
        ref={button}
        type="button"
        disabled={disabled}
        className="picker-toggle"
        aria-label={t('picker.chooseMonth')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => (open ? close(false) : show(true))}
      >
        <CalendarDays className="size-5" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={popId}
          role="dialog"
          aria-label={t('picker.calendar')}
          className={`picker-pop top-full mt-2 ${place.end ? 'end-0' : 'start-0'}`}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <button type="button" className="picker-nav" aria-label={t('picker.prevYear')} onClick={() => setYear((y) => y - 1)}>
              <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden="true" />
            </button>
            <span className="heading-card tabular-nums" aria-live="polite">
              {year}
            </span>
            <button type="button" className="picker-nav" aria-label={t('picker.nextYear')} onClick={() => setYear((y) => y + 1)}>
              <ChevronRight className="size-5 rtl:rotate-180" aria-hidden="true" />
            </button>
          </div>
          <div ref={grid} className="grid grid-cols-3 gap-1.5" onKeyDown={onGridKey}>
            {names.map((name, i) => {
              const m = i + 1;
              const ym = `${year}-${pad(m)}`;
              return (
                <button
                  key={m}
                  type="button"
                  data-month={m}
                  tabIndex={m === active ? 0 : -1}
                  className="picker-cell"
                  aria-pressed={ym === value}
                  aria-current={ym === today ? 'date' : undefined}
                  onClick={() => pick(m)}
                >
                  {/* Read out as "Jan 2026": the visible word stays in the name, for voice control. */}
                  {name}
                  <span className="sr-only"> {year}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-line pt-3">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                emit(today);
                close(true);
              }}
            >
              {t('picker.thisMonth')}
            </button>
            {!required && value && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  emit('');
                  close(true);
                }}
              >
                {t('picker.clear')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
