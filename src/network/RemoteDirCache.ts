import { RemoteDirCreateError } from '../types';

export type MkcolFn = (path: string) => Promise<number>;

// MKCOL statuses that PROVE the collection is on the server: just made (201), or already there (405).
const PROVEN_STATUSES = new Set([201, 405]);

// Tracks which remote collections exist and creates each only once at a time. Uploads serialize per PARENT dir, so
// F/a.md and F/sub/b.md run in parallel and race to MKCOL the shared ancestor F; Nextcloud answers the loser 423 Locked.
// A path is proven (201/405), in flight, or unknown. There is deliberately no "failed" state: 423 is transient, and
// remembering a failed MKCOL as created made the retry skip the MKCOL it needed (the PUT then 404'd again).
export class RemoteDirCache {
  // Paths a MKCOL has PROVEN to exist; never populated from a failure.
  private readonly proven = new Set<string>();
  // Paths with a MKCOL currently out, so a second caller joins it instead of racing it.
  private readonly inFlight = new Map<string, Promise<void>>();

  // At most one MKCOL per path at a time; callers arriving meanwhile share its outcome, failure included.
  // A failure leaves the path unknown so the next caller may retry.
  async ensure(path: string, mkcol: MkcolFn): Promise<void> {
    if (this.proven.has(path)) return;
    const running = this.inFlight.get(path);
    if (running) return running;

    const attempt = (async () => {
      let status: number;
      try {
        status = await mkcol(path);
      } catch (err) {
        throw new RemoteDirCreateError(path, 0, (err as Error)?.message);
      }
      if (!PROVEN_STATUSES.has(status)) throw new RemoteDirCreateError(path, status);
      this.proven.add(path);
    })();

    // Register before attaching anything else, so the entry exists however early `attempt` settles.
    this.inFlight.set(path, attempt);
    // Waiters get this very promise (same error as the first caller). The cleanup is its rejection handler, so a single-caller
    // failure is not unhandled; it must not be attached to the returned promise, which would swallow the rejection.
    // The identity check keeps this cleanup from deleting a newer attempt put in the map after a failure cleared the entry.
    const clear = () => { if (this.inFlight.get(path) === attempt) this.inFlight.delete(path); };
    attempt.then(clear, clear);
    return attempt;
  }

  // Drops every ancestor of remoteFilePath from the proven set after a PUT/MOVE answered 404/409 (e.g. another device
  // deleted the folder). In-flight entries stay: that MKCOL belongs to whoever is waiting on it.
  forgetAncestorsOf(remoteFilePath: string): void {
    for (const ancestor of ancestorsOf(remoteFilePath)) this.proven.delete(ancestor);
  }

  // Forgets every proven path, for when the vault folder turned out absent (its MKCOL answered 201).
  // In-flight MKCOLs are untouched, as in forgetAncestorsOf; one that succeeds re-proves its own path.
  clear(): void {
    this.proven.clear();
  }
}

// Every ancestor collection of a remote FILE path, outermost first (the file name is dropped).
export function ancestorsOf(remoteFilePath: string): string[] {
  const out: string[] = [];
  let acc = '';
  for (const segment of remoteFilePath.split('/').slice(0, -1)) {
    if (!segment) continue;
    acc = acc ? `${acc}/${segment}` : segment;
    out.push(acc);
  }
  return out;
}
