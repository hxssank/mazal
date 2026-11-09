import type { IncomingMessage } from 'node:http';
import { DocumentError } from './documents.ts';

export function readBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    let length = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      length += chunk.length;
      if (length > maximum) { settled = true; chunks.length = 0; reject(new DocumentError(413, `The request exceeds ${Math.round(maximum / 1024)} KB.`)); return; }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!settled) { settled = true; resolveBody(Buffer.concat(chunks)); } });
    request.on('aborted', () => { if (!settled) { settled = true; reject(new DocumentError(400, 'The upload stopped before the file was complete.')); } });
    request.on('error', error => { if (!settled) { settled = true; reject(error); } });
  });
}
