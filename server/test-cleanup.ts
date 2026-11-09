type Cleanup = () => void | Promise<void>;
type CleanupContext = { after: (cleanup: Cleanup) => void };
type Closeable = { close: Cleanup };

const scopes = new WeakMap<CleanupContext, Cleanup[]>();
const resources = new WeakMap<Closeable, Cleanup>();

export function deferTestCleanup(t: CleanupContext, cleanup: Cleanup): Cleanup {
  let pending = scopes.get(t);
  if (!pending) {
    pending = [];
    scopes.set(t, pending);
    const callbacks = pending;
    t.after(async () => {
      const errors: unknown[] = [];
      while (callbacks.length) {
        try { await callbacks.pop()!(); }
        catch (error) { errors.push(error); }
      }
      scopes.delete(t);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'Test cleanup failed');
    });
  }
  let active = true;
  let result: void | Promise<void>;
  const dispose = () => {
    if (active) {
      result = cleanup();
      active = false;
    }
    return result;
  };
  pending.push(dispose);
  return dispose;
}

export function trackTestResource<T extends Closeable>(t: CleanupContext, resource: T): T {
  if (resources.has(resource)) throw new Error('Test resource is already tracked');
  resources.set(resource, deferTestCleanup(t, () => resource.close()));
  return resource;
}

export function closeTestResource(resource: Closeable): void | Promise<void> {
  const dispose = resources.get(resource);
  if (!dispose) throw new Error('Test resource is not tracked');
  return dispose();
}
