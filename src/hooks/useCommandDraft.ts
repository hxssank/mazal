import { useCallback, useRef, useState } from 'react';
import type { Command } from '../../shared/types.ts';

export function useCommandDraft(revision:number, requestIdentity:'payload'|'form' = 'payload') {
  const [reviewedRevision, setReviewedRevision] = useState(revision);
  const request = useRef<{ signature:string; id:string }|null>(null);
  const resetRequest = useCallback(() => { request.current = null; }, []);
  const review = useCallback((keepRequest = false) => {
    setReviewedRevision(revision);
    if (!keepRequest) resetRequest();
  }, [revision, resetRequest]);
  const prepare = useCallback(<T extends Command>(command:T):T => {
    if (!('requestId' in command)) return {...command, expectedRevision:reviewedRevision};
    const signature = requestIdentity === 'form' ? 'form' : JSON.stringify({...command, requestId:undefined, expectedRevision:undefined});
    if (request.current?.signature !== signature) request.current = {signature, id:crypto.randomUUID()};
    return {...command, expectedRevision:reviewedRevision, requestId:request.current.id};
  }, [reviewedRevision, requestIdentity]);
  return { changed:revision !== reviewedRevision, review, prepare, resetRequest };
}
