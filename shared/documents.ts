export interface DocumentMetadata {
  id: string;
  originalName: string;
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/heic' | 'text/csv; charset=utf-8';
  bytes: number;
  sha256: string;
  kind: 'statement' | 'receipt' | 'other';
  accountId: string | null;
  documentDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  notes: string;
  amountCents: number | null;
  currency: 'CAD';
  expenseUse: 'personal' | 'business' | 'mixed' | 'unknown';
  merchant: string;
  createdAt: string;
  reviewStatus: 'needs_review' | 'reviewed';
  revision: number;
}
export interface DocumentList { documents: DocumentMetadata[]; storage: { usedBytes: number; freeBytes: number; limitPerFileBytes: number; documentCount: number } }
