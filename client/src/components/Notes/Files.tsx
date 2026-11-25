import { Download } from 'lucide-react';
import type { NoteArtifact } from '~/data-provider/Notes/notesCellsApi';
import { useDownload } from './useDownload';
import { formatFileSize } from '~/utils';
import { useLocalize } from '~/hooks';

const fileName = (artifact: NoteArtifact) =>
  artifact.relativePath.split('/').pop() || artifact.relativePath;

/** One chip per file the run wrote, under its output; a click saves the file. */
export function Files({ files, truncated }: { files: NoteArtifact[]; truncated?: boolean }) {
  const localize = useLocalize();
  const { download, pending } = useDownload();

  if (files.length === 0) {
    return null;
  }

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
              onClick={(event) => file.contentUrl && download(event, file.contentUrl, name)}
              aria-busy={pending === file.contentUrl}
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
