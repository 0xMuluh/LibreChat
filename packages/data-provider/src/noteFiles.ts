/**
 * A plot or table a note's R cell wrote, as the notes engine addresses it:
 * `<host and prefix>/projects/<note>/runs/<run>/plots|tables/<file>`. The engine serves these
 * files to OmicsBase only, so a link or image pointing there is broken for every reader; the
 * cell shows its plots and tables itself.
 */
export const ENGINE_RUN_FILE_URL =
  /[^\s()<>[\]"'`]*\/projects\/[^/\s()<>]+\/runs\/[^/\s()<>]+\/(plots|tables)\/([^/\s()<>?#]+)[^\s()<>[\]"'`]*/;

/** The kind and file name of an engine run file, or null for any other URL. */
export function engineRunFile(
  url?: string | null,
): { kind: 'plot' | 'table'; file: string } | null {
  const match = url ? ENGINE_RUN_FILE_URL.exec(url) : null;
  return match ? { kind: match[1] === 'plots' ? 'plot' : 'table', file: match[2] } : null;
}
