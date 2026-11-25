import { useState } from 'react';
import axios from 'axios';
import { Download } from 'lucide-react';
import { useToastContext } from '@librechat/client';
import type { MouseEvent } from 'react';
import type { NoteArtifact } from '~/data-provider/Notes/notesCellsApi';
import { formatFileSize, triggerDownload } from '~/utils';
import { useLocalize } from '~/hooks';

const fileName = (artifact: NoteArtifact) =>
  artifact.relativePath.split('/').pop() || artifact.relativePath;

/** One chip per file the run wrote, under its output; a click saves the file. */
export function Files({ files, truncated }: { files: NoteArtifact[]; truncated?: boolean }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [pending, setPending] = useState<string | null>(null);

  if (files.length === 0) {
    return null;
  }

  const download = async (event: MouseEvent<HTMLAnchorElement>, file: NoteArtifact) => {
    // The note routes read the sign-in from a header that a plain link does not send.
    event.preventDefault();
    if (!file.contentUrl || pending === file.id) {
      return;
    }
    const name = fileName(file);
    setPending(file.id);
    try {
      const res = await axios.get<Blob>(file.contentUrl, { responseType: 'blob' });
      triggerDownload(URL.createObjectURL(res.data), name);
    } catch {
      showToast({
        message: localize('com_ui_note_file_download_error', { 0: name }),
        status: 'error',
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="text-2xs mt-2.5" data-testid="note-cell-files">
      <div className="flex flex-wrap items-center gap-1.5">
        {files.map((file) => {
          const name = fileName(file);
          return (
            <a
              key={file.id}
              href={file.contentUrl ?? undefined}
              download={name}
              onClick={(event) => download(event, file)}
              aria-busy={pending === file.id}
              aria-label={localize('com_ui_note_download_file', { 0: name })}
              className="border-border-light text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-border-heavy dark:border-border-heavy inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 transition-colors focus-visible:outline focus-visible:outline-1"
            >
              <Download className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{name}</span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">{formatFileSize(file.byteSize)}</span>
            </a>
          );
        })}
      </div>
      {truncated && (
        <div className="text-text-tertiary mt-1">
          {localize('com_ui_note_files_truncated', { 0: files.length })}
        </div>
      )}
    </div>
  );
}
