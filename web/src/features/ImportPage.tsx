import { useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Card, Notice, PageHeader, Spinner, ScrollTable } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { errorMessage } from '../lib/errors';

type Kind = 'units' | 'residents';
interface ImportError {
  line: number;
  field: string;
  code: string;
}
interface Result {
  valid: boolean;
  rows: number;
  errors: ImportError[];
  created?: number;
  credentials?: { fullName: string; loginId: string; tempPassword: string; unitNumber: string | null }[];
}

const MAX_ROWS: Record<Kind, number> = { units: 2000, residents: 200 };
const MAX_FILE_BYTES = 600_000;
const SHOWN_ERRORS = 50;

function ImportCard({ kind }: { kind: Kind }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [check, setCheck] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  const checkFile = useMutation({
    mutationFn: (text: string) => api.post<Result>(`/api/import/${kind}?dryRun=true`, { csv: text }),
    onSuccess: setCheck,
    onError: setProblem,
  });
  const runImport = useMutation({
    mutationFn: () => api.post<Result>(`/api/import/${kind}`, { csv }),
    onSuccess: async (res) => {
      setDone(res);
      setCsv('');
      setCheck(null);
      await qc.invalidateQueries({ queryKey: ['units'] });
      await qc.invalidateQueries({ queryKey: ['residents'] });
    },
    onError: (e) => {
      // If the data changed under us the file may now have problems: show them rather than a bare error.
      if (e instanceof ApiError && e.code === 'IMPORT_INVALID') void checkFile.mutate(csv);
      else setProblem(e);
    },
  });

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setCheck(null);
    setDone(null);
    setProblem(null);
    setCsv('');
    setFileName(file?.name ?? '');
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setProblem(new ApiError(413, 'PAYLOAD_TOO_LARGE'));
      return;
    }
    const text = await file.text();
    setCsv(text);
    checkFile.mutate(text); // check straight away; nothing is saved by this
  }

  function reset() {
    setDone(null);
    setCheck(null);
    setCsv('');
    setFileName('');
    setProblem(null);
    if (input.current) input.current.value = '';
  }

  const busy = checkFile.isPending || runImport.isPending;
  const errors = check?.errors ?? [];

  return (
    <Card className="no-print-section">
      <h2 className="mb-1 heading-section">{t(`import.${kind}`)}</h2>
      <p className="text-sm text-muted">{t(kind === 'units' ? 'import.unitsColumns' : 'import.residentsColumns')}</p>
      <p className="mb-3 text-sm text-muted">{t('import.maxRows', { max: MAX_ROWS[kind] })}</p>

      {!done && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={`/api/import/templates/${kind}.csv`}
              download
              className="btn btn-secondary"
            >
              {t('import.downloadTemplate')}
            </a>
            <label className="btn btn-primary focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
              {t('import.chooseFile')}
              <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} disabled={busy} data-testid={`file-${kind}`} />
            </label>
            <span className="text-sm text-muted">{fileName || t('import.noFile')}</span>
          </div>

          {checkFile.isPending && <Spinner />}
          {problem !== null && <Notice>{errorMessage(t, problem)}</Notice>}

          {check?.valid && (
            <div className="space-y-3">
              <Notice tone="info">{t('import.ready', { count: check.rows })}</Notice>
              <Button disabled={busy} onClick={() => runImport.mutate()}>
                {runImport.isPending ? t('import.importing') : t('import.runImport', { count: check.rows })}
              </Button>
            </div>
          )}

          {check && !check.valid && (
            <div className="space-y-3">
              <Notice>{t('import.problems', { count: errors.length })}</Notice>
              <ScrollTable label={t('import.problems', { count: errors.length })}>
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="border-b border-line text-start">
                      <th className="whitespace-nowrap py-2 pe-3 text-start">{t('import.line')}</th>
                      <th className="whitespace-nowrap py-2 pe-3 text-start">{t('import.column')}</th>
                      <th className="py-2 text-start">{t('import.problem')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errors.slice(0, SHOWN_ERRORS).map((e, i) => (
                      <tr key={i} className="border-b border-line align-top">
                        <td className="whitespace-nowrap py-2 pe-3 font-semibold">{e.line}</td>
                        <td className="whitespace-nowrap py-2 pe-3 font-mono">{e.field === '_' ? '' : e.field}</td>
                        <td className="py-2">{t(`importErrors.${e.code}`, { defaultValue: e.code })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
              {errors.length > SHOWN_ERRORS && <p className="text-sm text-muted">{t('import.moreProblems', { count: errors.length - SHOWN_ERRORS })}</p>}
            </div>
          )}
        </div>
      )}

      {done && (
        <div className="space-y-4">
          <Notice tone="info">{t(kind === 'units' ? 'import.doneUnits' : 'import.doneResidents', { count: done.created ?? 0 })}</Notice>
          {done.credentials && done.credentials.length > 0 && (
            <div className="print-area space-y-3">
              <h3 className="heading-card">{t('import.credentialsTitle')}</h3>
              <p className="no-print text-sm font-medium text-danger">{t('import.credentialsHelp')}</p>
              <ScrollTable label={t('import.credentialsTitle')}>
                <table className="w-full text-sm" data-testid="credentials">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="py-2 pe-3 text-start">{t('common.name')}</th>
                      <th className="whitespace-nowrap py-2 pe-3 text-start">{t('import.unit')}</th>
                      <th className="py-2 pe-3 text-start">{t('common.loginId')}</th>
                      <th className="py-2 text-start">{t('temp.password')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {done.credentials.map((c) => (
                      <tr key={c.loginId} className="border-b border-line">
                        <td className="py-2 pe-3">{c.fullName}</td>
                        <td className="whitespace-nowrap py-2 pe-3">{c.unitNumber ?? ''}</td>
                        <td className="py-2 pe-3">{c.loginId}</td>
                        <td className="py-2 font-mono font-bold">{c.tempPassword}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
              <div className="no-print">
                <Button variant="secondary" onClick={() => window.print()}>
                  {t('import.print')}
                </Button>
              </div>
            </div>
          )}
          <div className="no-print">
            <Button variant="secondary" onClick={reset}>
              {t('import.another')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** FR-42: bulk import of units and residents from CSV, checked before anything is saved. */
export function ImportPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('import.title')} />
      <div className="mb-4 space-y-1">
        <p className="text-muted">{t('import.intro')}</p>
        <p className="font-semibold">{t('import.order')}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ImportCard kind="units" />
        <ImportCard kind="residents" />
      </div>
    </>
  );
}
