import path from 'path';
import { logger } from '@librechat/data-schemas';
import { FileSources, mergeFileConfig } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { TokenCountFn } from '~/utils/text';
import type { ServerRequest } from '~/types';
import { processTextWithTokenLimit } from '~/utils/text';

/**
 * Stand-in text for a user turn that carries attachments but no typed message.
 * Anthropic and the Assistants API both reject empty user content, and files
 * that reach the model out-of-band (RAG, code environment) leave nothing else
 * in the turn, so the payload needs this minimal note. The stored message keeps
 * its empty text so the UI still renders the attachment on its own.
 */
export const ATTACHMENT_ONLY_TEXT = 'Please refer to the attached file(s).';

/**
 * Title-generation input for a turn the user sent without typing anything.
 * Immediate title timing runs before any response exists, so the attachment
 * filenames are the only conversation-specific signal available; without them
 * the title model is prompted with an empty string and invents a topic.
 */
export function getAttachmentTitleText(files?: TFile[] | null): string {
  if (!files?.length) {
    return '';
  }

  const filenames = files.map((file) => file.filename).filter(Boolean);
  return filenames.length > 0 ? `Attached file(s): ${filenames.join(', ')}` : '';
}

const DEFAULT_INLINE_TEXT_LIMIT_BYTES = 51200; // 50 KB

const DEFAULT_DATA_EXTENSIONS = new Set([
  '.csv',
  '.tsv',
  '.tab',
  '.rds',
  '.rda',
  '.rdata',
  '.parquet',
  '.feather',
  '.arrow',
  '.h5ad',
  '.h5',
  '.hdf5',
  '.xlsx',
  '.xls',
  '.fasta',
  '.fa',
  '.fna',
  '.fastq',
  '.fq',
  '.bam',
  '.sam',
  '.cram',
  '.vcf',
  '.bcf',
  '.gtf',
  '.gff',
  '.gff3',
  '.bed',
  '.wig',
  '.bw',
  '.bigwig',
  '.mtx',
  '.loom',
  '.raw',
  '.mzml',
  '.mzxml',
  '.mgf',
  '.tar',
  '.gz',
  '.zip',
  '.bz2',
  '.xz',
]);

/**
 * Office spreadsheets have established provider document support, so they
 * remain eligible for normal document uploads. Other configured scientific
 * data extensions are treated as workspace data.
 */
const PROVIDER_DOCUMENT_DATA_EXTENSIONS = new Set(['.xlsx', '.xls']);

/**
 * Returns true for formats whose useful representation is the original file
 * in the R workspace. This deliberately uses only the filename extension so
 * a large PDF/image or an ordinary text document is never reclassified as
 * workspace data by size or storage source alone.
 */
export function isWorkspaceDataFileAttachment(
  file: Pick<IMongoFile, 'filename'> | null | undefined,
): boolean {
  if (!file?.filename) {
    return false;
  }
  const extension = path.extname(file.filename).toLowerCase();
  return (
    getConfiguredDataExtensions().has(extension) &&
    !PROVIDER_DOCUMENT_DATA_EXTENSIONS.has(extension)
  );
}

function getConfiguredDataExtensions(): Set<string> {
  const envExts = process.env.NOTE_DATA_EXTENSIONS;
  if (!envExts) {
    return DEFAULT_DATA_EXTENSIONS;
  }
  const set = new Set(DEFAULT_DATA_EXTENSIONS);
  for (const ext of envExts.split(',')) {
    const trimmed = ext.trim().toLowerCase();
    if (trimmed) {
      set.add(trimmed.startsWith('.') ? trimmed : `.${trimmed}`);
    }
  }
  return set;
}

function isTabularText(textSample?: string): boolean {
  if (!textSample) {
    return false;
  }
  const lines = textSample.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 5);
  if (lines.length < 2) {
    return false;
  }
  for (const delimiter of ['\t', ',', ';']) {
    const counts = lines.map((l) => l.split(delimiter).length);
    if (counts[0] > 1 && counts.every((c) => c === counts[0])) {
      return true;
    }
  }
  return false;
}

/**
 * Dynamically determines whether an uploaded attachment should be passed to the LLM
 * as an R workspace data reference (data/<filename>) or inlined as raw document text.
 */
export function isDataFileAttachment(file: any): boolean {
  if (!file) {
    return false;
  }
  const filename = file.filename || '';
  const ext = filename ? path.extname(filename).toLowerCase() : '';
  const dataExts = getConfiguredDataExtensions();

  if (dataExts.has(ext)) {
    return true;
  }

  // Size threshold: non-image files larger than 50 KB are treated as data files to save tokens
  const limitBytes = Number(process.env.NOTE_DATA_MAX_INLINE_BYTES) || DEFAULT_INLINE_TEXT_LIMIT_BYTES;
  if (file.bytes && file.bytes > limitBytes) {
    return true;
  }

  // Non-text file sources (e.g. binary upload without text extraction)
  if (file.source && file.source !== FileSources.text) {
    return true;
  }

  // Tabular delimiter sniffing
  if (file.text && isTabularText(file.text.slice(0, 2048))) {
    return true;
  }

  return false;
}

/**
 * Extracts text context from attachments and returns formatted text.
 * This handles text that was already extracted from files (OCR, transcriptions, document text, etc.)
 * as well as data files bridged directly into the R NoteKernel workspace.
 * @param params - The parameters object
 * @param params.attachments - Array of file attachments
 * @param params.req - Express request object for config access
 * @param params.tokenCountFn - Function to count tokens in text
 * @returns The formatted file context text, or undefined if no text found
 */
export async function extractFileContext({
  attachments,
  req,
  tokenCountFn,
}: {
  attachments: readonly (Pick<TFile, 'text' | 'filename'> & {
    source?: string;
    llmDeliveryPath?: string;
    bytes?: number;
  })[];
  req?: ServerRequest;
  tokenCountFn: TokenCountFn;
}): Promise<string | undefined> {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const fileConfig = mergeFileConfig(req?.config?.fileConfig);
  const fileTokenLimit = req?.body?.fileTokenLimit ?? fileConfig.fileTokenLimit;

  if (!fileTokenLimit) {
    // If no token limit, return undefined (no processing)
    return undefined;
  }

  let resultText = '';
  let dataContext = '';

  for (const file of attachments) {
    if (isDataFileAttachment(file)) {
      dataContext += `- \`data/${file.filename}\` (Name: "${file.filename}")\n`;
      continue;
    }

    const source = file.source ?? FileSources.local;
    if (file.llmDeliveryPath === 'none') {
      continue;
    }

    const hasTextDelivery = file.llmDeliveryPath === 'text' || source === FileSources.text;
    if (hasTextDelivery && file.text) {
      const { text: limitedText, wasTruncated } = await processTextWithTokenLimit({
        text: file.text,
        tokenLimit: fileTokenLimit,
        tokenCountFn,
      });

      if (wasTruncated) {
        logger.debug(
          `[extractFileContext] Text content truncated for file: ${file.filename} due to token limits`,
        );
      }

      resultText += `${!resultText ? 'Attached document(s):\n```md\n' : '\n\n---\n\n'}# "${file.filename}"\n${limitedText}\n`;
    }
  }

  if (resultText && !dataContext) {
    resultText += '\n```';
    return resultText;
  }

  if (dataContext) {
    const noteGuidance = `\n[Attached Data Files in R Workspace]\nThe following dataset(s) are attached for preparation in your R NoteKernel workspace (\`data/\`):\n${dataContext}\n**Analysis Instructions for Agent:**\n- The execution service prepares working copies before running R. If preparation fails, report the error; do not assume the upload is missing or ask for re-upload.\n- Load them directly in R using appropriate functions (e.g. \`read.csv("data/<filename>")\` or \`readRDS("data/<filename>")\`).\n- Inspect dimensions and data summaries, then proceed with the requested omics analysis.\n`;
    if (resultText) {
      return resultText + '\n```\n' + noteGuidance;
    }
    return noteGuidance;
  }

  return undefined;
}
