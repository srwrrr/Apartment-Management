import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50',
  secondary: 'bg-white text-ink border border-line hover:bg-brand-50 disabled:opacity-50',
  danger: 'bg-danger-600 text-white hover:bg-red-800 disabled:opacity-50',
  ghost: 'bg-transparent text-brand-700 hover:bg-brand-50 disabled:opacity-50',
};

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      // min-h-11 keeps touch targets at least 44 px (NFR-10).
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-base font-semibold transition-colors disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    />
  );
}

export function Field({
  label,
  error,
  help,
  optional,
  children,
}: {
  label: string;
  error?: string;
  help?: string;
  optional?: boolean;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const descId = error || help ? `${id}-desc` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
        {optional && <span className="ml-1 font-normal text-muted">({t('common.optional')})</span>}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': descId })}
      {error ? (
        <p id={descId} role="alert" className="text-sm font-medium text-danger-600">
          {error}
        </p>
      ) : help ? (
        <p id={descId} className="text-sm text-muted">
          {help}
        </p>
      ) : null}
    </div>
  );
}

const inputClass =
  'block min-h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-base aria-[invalid=true]:border-danger-600 disabled:bg-page';

export const TextInput = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={`${inputClass} ${props.className ?? ''}`} />;
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} className={`${inputClass} ${props.className ?? ''}`} />;
export const TextArea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={4} {...props} className={`${inputClass} ${props.className ?? ''}`} />;

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-line bg-surface p-4 shadow-sm sm:p-6 ${className}`}>{children}</section>;
}

const tones = {
  green: 'bg-brand-100 text-brand-900',
  gray: 'bg-gray-200 text-gray-900',
  amber: 'bg-warn-50 text-warn-700',
  red: 'bg-danger-50 text-danger-600',
  blue: 'bg-blue-100 text-blue-900',
};
/** Status is always shown as text; colour only reinforces it (UI-06). */
export function Chip({ tone = 'gray', children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-sm font-semibold ${tones[tone]}`}>{children}</span>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold">{title}</h1>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export function Notice({ tone = 'error', children }: { tone?: 'error' | 'info'; children: ReactNode }) {
  const cls = tone === 'error' ? 'border-danger-600 bg-danger-50 text-danger-600' : 'border-brand-600 bg-brand-50 text-brand-900';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border-l-4 px-4 py-3 text-base font-medium ${cls}`}>
      {children}
    </div>
  );
}

export function Spinner() {
  const { t } = useTranslation();
  return (
    <p role="status" className="py-8 text-center text-muted">
      {t('common.loading')}
    </p>
  );
}

/** A dialog with a focus trap, Escape to close, and focus returned afterwards (NFR-12). */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])'));
    (focusables()[0] ?? node).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <h2 id={titleId} className="mb-4 text-xl font-bold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <p className="mt-3 text-sm text-muted">{t('common.total', { count: total })}</p>;
  return (
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-2" aria-label="pagination">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {t('common.previous')}
      </Button>
      <span className="text-sm text-muted">{t('common.page', { page, pages })}</span>
      <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t('common.next')}
      </Button>
    </nav>
  );
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** One-time temporary password, shown after creating or resetting an account (FR-03, FR-06, FR-31). */
export function TempPasswordModal({ loginId, password, onClose }: { loginId: string; password: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Modal title={t('temp.title')} onClose={onClose}>
      <div className="space-y-4">
        <Notice tone="info">{t('temp.body')}</Notice>
        <dl className="space-y-2 rounded-lg bg-page p-3">
          <div>
            <dt className="text-sm text-muted">{t('temp.loginId')}</dt>
            <dd className="font-semibold">{loginId}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t('temp.password')}</dt>
            <dd className="font-mono text-2xl font-bold tracking-wider" data-testid="temp-password">
              {password}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(password).then(() => setCopied(true)).catch(() => undefined);
            }}
          >
            {copied ? t('common.copied') : t('common.copy')}
          </Button>
          <Button onClick={onClose}>{t('temp.done')}</Button>
        </div>
      </div>
    </Modal>
  );
}
