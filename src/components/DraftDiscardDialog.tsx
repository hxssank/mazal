import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import './draft-discard.css';

export default function DraftDiscardDialog({ open, onDiscard, onKeepEditing, uncertain = false }: { open: boolean; onDiscard: () => void; onKeepEditing: () => void; uncertain?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    keepEditing.current?.focus();
    return () => { if (element?.open) element.close(); };
  }, [open]);
  function keepDraft() {
    const previous = trigger.current;
    onKeepEditing();
    window.requestAnimationFrame(() => {
      if (previous?.isConnected && !previous.closest('[hidden]')) previous.focus({ preventScroll: true });
    });
  }
  if (!open) return null;
  return createPortal(<dialog ref={dialog} className="portfolio-dialog draft-discard-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`} onCancel={event => { event.preventDefault(); keepDraft(); }}>
    <header className="portfolio-dialog-header"><h2 id={`${id}-title`}>{uncertain ? 'Check the original save' : 'Discard unsaved changes?'}</h2></header>
    <div className="portfolio-dialog-body"><p id={`${id}-message`}>{uncertain ? 'The original save may already be recorded. Closing this draft does not undo it. Check your records before adding it again.' : 'Your changes have not been saved. Keep editing or discard them to continue.'}</p></div>
    <footer className="portfolio-dialog-footer"><button type="button" ref={keepEditing} className="button primary" onClick={keepDraft}>Keep editing</button><button type="button" className="button secondary" onClick={onDiscard}>{uncertain ? 'Close and check records' : 'Discard changes'}</button></footer>
  </dialog>, document.querySelector('.app-shell') ?? document.body);
}
