import { parentPort } from 'node:worker_threads';
import { parseFederationMetadata } from './metadata';

export interface MetadataJob {
  xml: string;
  cert: string;
}

parentPort?.once('message', ({ xml, cert }: MetadataJob) => {
  parentPort?.postMessage(parseFederationMetadata(xml, cert));
});
