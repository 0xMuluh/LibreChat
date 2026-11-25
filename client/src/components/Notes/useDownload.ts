import { useState } from 'react';
import axios from 'axios';
import { useToastContext } from '@librechat/client';
import type { MouseEvent } from 'react';
import { triggerDownload } from '~/utils';
import { useLocalize } from '~/hooks';

/**
 * Saves a run's output file. The note routes read the sign-in from a header that a plain
 * link does not send, so the click fetches the file and saves the response instead.
 */
export function useDownload() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [pending, setPending] = useState<string | null>(null);

  const download = async (event: MouseEvent<HTMLAnchorElement>, url: string, name: string) => {
    event.preventDefault();
    if (pending === url) {
      return;
    }
    setPending(url);
    try {
      const res = await axios.get<Blob>(url, { responseType: 'blob' });
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

  return { download, pending };
}
