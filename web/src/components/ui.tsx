import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';


export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`btn btn-${variant} ${className}`}
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
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
        {optional && <span className="ml-1 font-normal text-muted">({t('common.optional')})</span>}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': descId })}
      {error ? (
        <p id={descId} role="alert" className="text-sm font-medium text-danger">
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

export const TextInput = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={`field ${props.className ?? ''}`} />;
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} className={`field ${props.className ?? ''}`} />;
export const TextArea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={4} {...props} className={`field ${props.className ?? ''}`} />;

/** A wide table that scrolls sideways on a phone. It can take focus so keyboard users can scroll it too (NFR-12). */
export function ScrollTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="scroll-quiet overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`glass p-4 sm:p-6 ${className}`}>{children}</section>;
}

const tones = {
  green: 'bg-accent-soft text-accent',
  gray: 'bg-neutral-soft text-ink',
  amber: 'bg-warn-soft text-warn',
  red: 'bg-danger-soft text-danger',
  blue: 'bg-info-soft text-info',
};
/** Status is always shown as text; colour only reinforces it (UI-06). */
export function Chip({ tone = 'gray', children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={`chip ${tones[tone]}`}>{children}</span>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="heading-page">{title}</h1>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export function Notice({ tone = 'error', children }: { tone?: 'error' | 'info'; children: ReactNode }) {
  const cls = tone === 'error' ? 'border-danger bg-danger-soft text-danger' : 'border-accent bg-accent-soft text-ink';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border-s-[3px] px-4 py-3 text-base font-medium ${cls}`}>
      {children}
    </div>
  );
}

export function Spinner() {
  const { t } = useTranslation();
  return (
    <p role="status" className="flex items-center justify-center gap-3 py-10 text-muted">
      <span className="spinner" aria-hidden="true" />
      {t('common.loading')}
    </p>
  );
}

/** A dialog with a focus trap, Escape to close, and focus returned afterwards (NFR-12). */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Parents remove a dialog at once, so an empty frame of the same size plays the closing animation in its place.
  // Empty on purpose: no labels or fields are duplicated, and a one-time password does not stay on the page.
  useLayoutEffect(() => {
    let open = true;
    const node = overlay.current!;
    const panel = ref.current!;
    return () => {
      open = false;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const { width, height } = panel.getBoundingClientRect();
      const frame = document.createElement('div');
      frame.className = panel.className;
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      const ghost = document.createElement('div');
      ghost.className = `${node.className} modal-leaving`;
      ghost.setAttribute('aria-hidden', 'true');
      ghost.append(frame);
      // A development re-run mounts it straight back: only a real close gets the animation.
      queueMicrotask(() => {
        if (open) return;
        document.body.append(ghost);
        setTimeout(() => ghost.remove(), 170);
      });
    };
  }, []);

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

  // Sits under <body>: glass creates its own frame for fixed elements, so inside a card a dialog would not cover the screen.
  return createPortal(
    <div ref={overlay} className="modal-backdrop fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="modal-panel scroll-quiet max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-3xl p-5 sm:rounded-3xl sm:p-6">
        <h2 id={titleId} className="heading-section mb-4">
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <p className="mt-3 text-sm text-muted">{t('common.total', { count: total })}</p>;
  return (
    <nav className="mt-5 flex flex-wrap items-center justify-between gap-2" aria-label="pagination">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
        {t('common.previous')}
      </Button>
      <span className="text-sm text-muted">{t('common.page', { page, pages })}</span>
      <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t('common.next')}
        <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
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
        <dl className="tile space-y-2">
          <div>
            <dt className="text-sm text-muted">{t('temp.loginId')}</dt>
            <dd className="font-semibold">{loginId}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t('temp.password')}</dt>
            <dd className="font-mono text-2xl font-semibold tracking-wider text-accent" data-testid="temp-password">
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
