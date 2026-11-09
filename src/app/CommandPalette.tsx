import { useEffect, useId, useRef, useState } from 'react';
import Icon from '../components/Icon.tsx';
import './command-palette.css';

export interface CommandAction {
  id: string;
  label: string;
  description: string;
  icon: string;
  group: 'Go to' | 'Actions';
  keywords?: string;
  run: () => void;
}

export default function CommandPalette({ actions, onSelect, onClose }: {
  actions: CommandAction[];
  onSelect: (action: CommandAction) => void;
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const results = actions.filter(action => terms.every(term => `${action.label} ${action.description} ${action.keywords ?? ''}`.toLocaleLowerCase().includes(term))).sort((first, second) => {
    const rank = (action: CommandAction) => terms.every(term => action.label.toLocaleLowerCase().includes(term)) ? 0 : 1;
    return rank(first) - rank(second);
  });
  const selected = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => element?.close();
  }, []);
  useEffect(() => {
    dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, query]);

  return <dialog ref={dialog} className="command-palette" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="command-palette-body">
      <header className="command-search">
        <Icon name="search" size={21}/>
        <h2 id={`${id}-title`} className="sr-only">Search and quick actions</h2>
        <input ref={input} role="combobox" aria-label="Search pages and actions" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-results`} aria-activedescendant={results.length ? `${id}-${results[selected].id}` : undefined} autoComplete="off" spellCheck={false} placeholder="Where would you like to go?" value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (results.length) setActive((selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
          } else if (event.key === 'Enter' && results[selected]) {
            event.preventDefault();
            onSelect(results[selected]);
          }
        }}/>
        <button type="button" className="command-close" aria-label="Close search" onClick={onClose}><Icon name="close" size={18}/></button>
      </header>
      <div className="command-results" role="listbox" id={`${id}-results`} aria-label="Pages and actions">
        {results.map((action, index) => <div key={action.id}>
          {(index === 0 || results[index - 1].group !== action.group) && <p className="command-group" aria-hidden="true">{action.group}</p>}
          <button type="button" role="option" tabIndex={-1} id={`${id}-${action.id}`} aria-selected={index === selected} className="command-result" onClick={() => onSelect(action)} onPointerMove={event => { if (event.pointerType === 'mouse') setActive(index); }}>
            <span className="command-result-icon"><Icon name={action.icon} size={19}/></span>
            <span className="command-result-copy"><strong>{action.label}</strong><small>{action.description}</small></span>
            <Icon name="arrow" size={16}/>
          </button>
        </div>)}
      </div>
      {!results.length && <div className="command-empty" role="status"><Icon name="search" size={27}/><strong>No matching pages or actions</strong><p>Try "bills", "pay", "transfer", or "accounts".</p><button type="button" className="text-button" onClick={() => { setQuery(''); setActive(0); input.current?.focus(); }}>Clear search</button></div>}
      <footer className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> to move <kbd>↵</kbd> to open</span><span><kbd>esc</kbd> to close</span></footer>
      <span className="sr-only" role="status">{results.length} {results.length === 1 ? 'result' : 'results'}</span>
    </div>
  </dialog>;
}
