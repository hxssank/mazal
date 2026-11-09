export const MAX_DOCUMENT_ARCHIVE_BYTES = 256 * 1024 * 1024;

export interface RecoveryIssue {
  kind: 'missing_original' | 'damaged_original' | 'missing_account' | 'unlinked_document' | 'missing_statement_source' | 'missing_source_reference' | 'incomplete_recovery';
  documentId?: string;
  sourceFile?: string;
  message: string;
}

export interface DocumentRecoveryHealth {
  revision: number;
  documents: number;
  missingOriginals: number;
  damagedOriginals: number;
  unlinkedDocuments: number;
  missingAccountLinks: number;
  statementSources: number;
  missingStatementSources: number;
  sourceReferences?: number;
  missingSourceReferences?: number;
  incompleteRecoveries?: number;
  issues: RecoveryIssue[];
}

export interface DocumentRestorePreview {
  token: string;
  expectedRevision: number;
  archiveSha256: string;
  counts: { documents: number; reviewSources: number; newDocuments: number; existingDocuments: number; missingOriginals: number; unresolvedLinks: number; conflicts: number };
  documents: {
    id: string;
    originalName: string;
    bytes: number;
    status: 'new' | 'existing' | 'repair' | 'conflict';
    originalAccountId: string | null;
    suggestedAccountId: string | null;
    linkReason: 'account_id' | 'statement_source' | 'unlinked' | 'unresolved';
    conflict?: string;
  }[];
  reviewSources: { sha256: string; sourceFiles: string[]; bytes: number; status: 'new' | 'existing' | 'conflict'; conflict?: string }[];
  conflicts: string[];
}

export interface DocumentRestoreCommit {
  token: string;
  expectedRevision: number;
  accountMappings?: Record<string, string | null>;
}

export interface DocumentRestoreResult {
  status: 'restored';
  documentsAdded: number;
  originalsRepaired: number;
  documentsPreserved: number;
  reviewSourcesRestored: number;
  unlinkedDocuments: number;
  archiveSha256: string;
  recovery: DocumentRecoveryHealth;
}
