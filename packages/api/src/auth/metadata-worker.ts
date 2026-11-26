import { readFileSync } from 'node:fs';
import { parseFederationMetadata } from './metadata';

/** The metadata to verify: a file the parent wrote, so the XML is not copied through IPC. */
export interface MetadataJob {
  file: string;
  cert: string;
}

process.once('message', (message) => {
  const { file, cert } = message as MetadataJob;
  const result = parseFederationMetadata(readFileSync(file, 'utf8'), cert);
  process.send?.(result, () => process.disconnect());
});
