/**
 * Hex sticker shown beside a book badge, by book slug. A book without a sticker of its own
 * shows its core package's sticker; sources and licences are in public/assets/books/README.md.
 */
const stickers: Record<string, string> = {
  oma: 'mia',
  osta: 'OSTA',
  tidyomics: 'tidyomics',
  'tidy-spatial': 'tidyomics',
  metabonaut: 'metabonaut',
  osca: 'SingleCellExperiment',
  'osca-basic': 'SingleCellExperiment',
  'osca-advanced': 'SingleCellExperiment',
  'rnaseq-gene': 'DESeq2',
  'r-for-mass-spectrometry': 'Spectra',
};

export function stickerUrl(book: string): string | null {
  const name = stickers[book];
  return name ? `assets/books/${name}.png` : null;
}
