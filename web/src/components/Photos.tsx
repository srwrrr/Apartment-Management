import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_PHOTOS, MAX_PHOTO_BYTES } from '@apt/shared';
import type { Photo } from '../lib/types';
import { Button } from './ui';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Chooses up to three photos (BR-19). The checks here only save a wasted upload;
 * the server looks at what each file really is and has the final say.
 */
export function PhotoPicker({ files, onChange, error, id }: { files: File[]; onChange: (f: File[]) => void; error?: string; id?: string }) {
  const { t } = useTranslation();
  const [localError, setLocalError] = useState('');
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  function add(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    let problem = '';
    for (const f of Array.from(list)) {
      if (next.length >= MAX_PHOTOS) problem = t('fieldErrors.TOO_MANY_FILES');
      else if (!ALLOWED.includes(f.type)) problem = t('fieldErrors.FILE_TYPE_NOT_ALLOWED');
      else if (f.size > MAX_PHOTO_BYTES) problem = t('fieldErrors.FILE_TOO_LARGE');
      else next.push(f);
    }
    setLocalError(problem);
    onChange(next);
  }

  const shown = localError || error;
  return (
    <div className="space-y-2">
      {files.length < MAX_PHOTOS && (
        <label className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line bg-white px-4 py-2 font-semibold text-brand-700 hover:bg-brand-50 focus-within:outline focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-blue-600">
          {t('maintenance.addPhotos')}
          <input
            id={id}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="sr-only"
            data-testid="photo-input"
            onChange={(e) => {
              add(e.target.files);
              e.target.value = ''; // allows choosing the same file again after removing it
            }}
          />
        </label>
      )}
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-3">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="w-28 space-y-1">
              <img src={previews[i]} alt={f.name} className="h-24 w-28 rounded-lg border border-line object-cover" />
              <Button variant="ghost" className="!min-h-9 w-full !px-1 text-sm" onClick={() => onChange(files.filter((_, j) => j !== i))}>
                {t('maintenance.removePhoto')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {shown && (
        <p role="alert" className="text-sm font-medium text-danger-600">
          {shown}
        </p>
      )}
    </div>
  );
}

/** Photos that are already saved. Each is fetched through the server, which checks who is asking. */
export function PhotoGrid({ photos }: { photos: Photo[] }) {
  const { t } = useTranslation();
  if (photos.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-3" data-testid="photos">
      {photos.map((p) => (
        <li key={p.id}>
          <a href={`/api/attachments/${p.id}`} target="_blank" rel="noopener" aria-label={`${t('maintenance.openPhoto')}: ${p.name}`}>
            <img src={`/api/attachments/${p.id}`} alt={p.name} loading="lazy" className="h-28 w-36 rounded-lg border border-line object-cover" />
          </a>
        </li>
      ))}
    </ul>
  );
}
