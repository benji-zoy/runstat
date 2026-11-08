/** Web Locks (onglets, worker) ; `ifAvailable` : null si déjà pris. Sans l'API (anciens navigateurs), appel direct. */
export async function withLock<T>(name: string, fn: () => Promise<T>, ifAvailable = false): Promise<T | null> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return fn();
  return locks.request(name, { ifAvailable }, async (lock) => (lock ? fn() : null)) as Promise<T | null>;
}
