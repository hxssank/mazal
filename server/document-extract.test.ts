import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDocumentExtractor, MAX_EXTRACTION_BYTES, validateExtraction } from './document-extract.ts';
import { DocumentError } from './documents.ts';

function pdf(pages = 1): Buffer {
  const stream = 'BT /F1 24 Tf 50 700 Td (Mazal payroll 123.45) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({length:pages}, (_, index) => `${index + 5} 0 R`).join(' ')}] /Count ${pages} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ...Array.from({length:pages}, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>'),
  ];
  let result = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

test('local extraction rejects oversized files, forged types and unsupported content', () => {
  assert.equal(validateExtraction(pdf(), 'application/pdf'), '.pdf');
  assert.throws(() => validateExtraction(pdf(), 'image/png'), error => error instanceof DocumentError && error.status === 415);
  assert.throws(() => validateExtraction(Buffer.alloc(MAX_EXTRACTION_BYTES + 1), 'application/pdf'), error => error instanceof DocumentError && error.status === 413);
  assert.throws(() => validateExtraction(Buffer.from('income,100'), 'text/csv'), error => error instanceof DocumentError && error.status === 415);
});

test('Mac text extraction reads selectable PDF text, serializes work and enforces the page limit', {skip:process.platform !== 'darwin'}, async () => {
  const extractor = createDocumentExtractor(fileURLToPath(new URL('..', import.meta.url)));
  try {
    const pending = extractor.extract(pdf(), 'application/pdf');
    await assert.rejects(extractor.extract(pdf(), 'application/pdf'), error => error instanceof DocumentError && error.status === 409);
    const result = await pending;
    assert.deepEqual(result.pages, [{page:1,text:'Mazal payroll 123.45',method:'pdf-text'}]);
    assert.match(result.warnings[0], /Compare extracted text/);
    await assert.rejects(extractor.extract(pdf(21), 'application/pdf'), error => error instanceof DocumentError && error.status === 413);
    await assert.rejects(extractor.extract(Buffer.from('%PDF-1.7\nBroken PDF'), 'application/pdf'), error => error instanceof DocumentError && error.status === 422);
  } finally { await extractor.close(); }
});
