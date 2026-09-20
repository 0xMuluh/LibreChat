import type { TFile } from 'librechat-data-provider';
import { getAttachmentTitleText, isWorkspaceDataFileAttachment } from './context';

const file = (filename?: string): TFile => ({ filename }) as TFile;

describe('getAttachmentTitleText', () => {
  it('returns an empty string when there are no files', () => {
    expect(getAttachmentTitleText()).toBe('');
    expect(getAttachmentTitleText(null)).toBe('');
    expect(getAttachmentTitleText([])).toBe('');
  });

  it('lists a single filename', () => {
    expect(getAttachmentTitleText([file('report.pdf')])).toBe('Attached file(s): report.pdf');
  });

  it('lists every filename', () => {
    expect(getAttachmentTitleText([file('a.pdf'), file('b.csv')])).toBe(
      'Attached file(s): a.pdf, b.csv',
    );
  });

  it('skips files that carry no filename', () => {
    expect(getAttachmentTitleText([file(), file('kept.txt')])).toBe('Attached file(s): kept.txt');
  });

  it('returns an empty string when no file has a filename', () => {
    expect(getAttachmentTitleText([file(), file()])).toBe('');
  });
});

describe('isWorkspaceDataFileAttachment', () => {
  it.each(['wilcox_phylum.csv', 'counts.tsv', 'object.RDS', 'matrix.h5ad', 'sample.mzML'])(
    'recognizes %s as workspace data',
    (filename) => {
      expect(isWorkspaceDataFileAttachment(file(filename))).toBe(true);
    },
  );

  it('leaves provider document formats eligible', () => {
    expect(isWorkspaceDataFileAttachment(file('report.pdf'))).toBe(false);
    expect(isWorkspaceDataFileAttachment(file('table.xlsx'))).toBe(false);
    expect(isWorkspaceDataFileAttachment(file('notes.txt'))).toBe(false);
  });
});
