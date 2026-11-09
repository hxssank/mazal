interface Entry { session: string; index: number; hash: string }
interface Options {
  window: Window;
  requestNavigation: (proceed: () => void) => boolean;
  onNavigate: (hash: string) => void;
}
const stateKey = 'mazalNavigation';

export function createGuardedHistory({ window, requestNavigation, onNavigate }: Options) {
  const { history, location } = window;
  const previous = history.state?.[stateKey];
  const session = typeof previous?.session === 'string' ? previous.session : crypto.randomUUID();
  let accepted: Entry = { session, index: Number.isSafeInteger(previous?.index) ? previous.index : 0, hash: location.hash };
  let restoring: { target: Entry; approved: boolean } | null = null;
  let approvedTarget: Entry | null = null;
  let afterRestore: (() => void) | null = null;
  let generation = 0;
  let disposed = false;

  function stamp(entry: Entry) {
    history.replaceState({ ...history.state, [stateKey]: { session, index: entry.index } }, '', entry.hash || location.pathname + location.search);
  }
  stamp(accepted);
  function same(left: Entry, right: Entry) { return left.index === right.index && left.hash === right.hash; }
  function accept(entry: Entry) { accepted = entry; onNavigate(entry.hash); }
  function resume(target: Entry) {
    approvedTarget = target;
    history.go(target.index - accepted.index);
  }
  function changed() {
    if (disposed) return;
    const marker = history.state?.[stateKey];
    const entry: Entry = { session, index: marker?.session === session && Number.isSafeInteger(marker.index) ? marker.index : accepted.index + 1, hash: location.hash };
    if (marker?.session !== session || marker.index !== entry.index) stamp(entry);
    if (same(entry, accepted)) {
      const pending = restoring;
      restoring = null;
      if (afterRestore) { const next = afterRestore; afterRestore = null; next(); }
      else if (pending?.approved) resume(pending.target);
      return;
    }
    if (restoring) return;
    if (approvedTarget && same(entry, approvedTarget)) { approvedTarget = null; accept(entry); return; }
    approvedTarget = null;
    const token = ++generation;
    let synchronous = true;
    let allowed = false;
    requestNavigation(() => {
      if (disposed || token !== generation) return;
      if (synchronous) { allowed = true; accept(entry); }
      else if (restoring) restoring.approved = true;
      else resume(entry);
    });
    synchronous = false;
    if (!allowed) {
      restoring = { target: entry, approved: false };
      history.go(accepted.index - entry.index);
    }
  }
  window.addEventListener('popstate', changed);
  window.addEventListener('hashchange', changed);
  return {
    navigate(hash: string) {
      requestNavigation(() => {
        if (disposed) return;
        generation++;
        approvedTarget = null;
        const push = () => {
          const entry = { session, index: accepted.index + (hash === accepted.hash ? 0 : 1), hash };
          if (hash !== accepted.hash) history.pushState({ [stateKey]: { session, index: entry.index } }, '', hash);
          accept(entry);
        };
        if (restoring) { restoring.approved = false; afterRestore = push; }
        else push();
      });
    },
    dispose() {
      disposed = true;
      generation++;
      window.removeEventListener('popstate', changed);
      window.removeEventListener('hashchange', changed);
    },
  };
}
