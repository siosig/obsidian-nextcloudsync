import { RemoteDirCreateError } from '../types';

/** Issues one MKCOL for `path` and answers with the HTTP status (or throws if the request itself failed). */
export type MkcolFn = (path: string) => Promise<number>;

/** MKCOL statuses that PROVE the collection is on the server: it was just made, or it was already there. */
const PROVEN_STATUSES = new Set([201, 405]);

/**
 * Tracks which remote collections are known to exist, and makes sure a collection is only ever
 * created once at a time (feature 088).
 *
 * WebDAV's PUT does not create parent collections, so every upload into a folder the server has not
 * seen yet MKCOLs its ancestors first. Two facts made that go wrong:
 *
 * 1. Uploads are serialized per PARENT directory (SyncEngine.runFileBatch, `serializeByDir`), so
 *    `F/a.md` and `F/sub/b.md` run in parallel — different parents — while needing the same
 *    ANCESTOR `F`. Nextcloud locks a collection while creating it and answers the loser of that race
 *    with 423 Locked, so one of the two MKCOLs simply fails. Measured against a live Nextcloud 34 on
 *    2026-09-10: four concurrent MKCOLs of one collection returned [201, 423, 405, 423], and a plain
 *    two-file race failed three times out of six.
 * 2. The old cache was a bare Set that the MKCOL loop wrote to without ever looking at the status.
 *    A failed MKCOL was therefore remembered as "already created" for the rest of the session, which
 *    is what made the reactive recovery useless: the retry skipped the MKCOL it needed and the PUT
 *    404'd again.
 *
 * So a path here is in exactly one of three states — proven (201/405 came back), in flight (a MKCOL
 * is out and nobody knows yet), or unknown. There is deliberately no fourth "failed" state: a 423 is
 * transient by nature, and remembering failures is the very defect this class exists to remove.
 */
export class RemoteDirCache {
  /** Paths a MKCOL has PROVEN to exist. Never populated from a failure. */
  private readonly proven = new Set<string>();
  /** Paths with a MKCOL currently out, so a second caller joins it instead of racing it. */
  private readonly inFlight = new Map<string, Promise<void>>();

  /**
   * Make sure `path` exists on the server, issuing at most one MKCOL for it at a time.
   *
   * Callers that arrive while a MKCOL is out share its outcome — including its failure, so no caller
   * is told the collection is there when it is not. A failure leaves the path unknown rather than
   * remembered, so the next caller may try again.
   */
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

    // Register before attaching anything else, so the entry exists no matter how early `attempt`
    // settles — clearing it first would leave a settled promise in the map for every later caller.
    this.inFlight.set(path, attempt);
    // Waiters get this very promise, so they reject with the SAME error the first caller sees.
    // The cleanup doubles as that promise's rejection handler, which is what keeps a failure with a
    // single caller from being reported as unhandled — note it takes BOTH callbacks for that reason,
    // and that it must not be attached to the promise the callers receive, which would swallow the
    // rejection and make every waiter resolve on a MKCOL that failed.
    // The identity check matters once a failure has already cleared the entry and a later call has
    // put its own attempt in the map: this cleanup must not delete that newer one.
    const clear = () => { if (this.inFlight.get(path) === attempt) this.inFlight.delete(path); };
    attempt.then(clear, clear);
    return attempt;
  }

  /**
   * Drop every ancestor of `remoteFilePath` from the proven set, because a write just proved one of
   * them is missing (a PUT or MOVE answered 404/409). Without this, a folder another device deleted
   * after this client created it stays "proven" and the retry skips the MKCOL that would bring it
   * back — the bug feature 024 fixed for one client and this class now fixes for both.
   *
   * In-flight entries are left alone on purpose: that MKCOL belongs to whoever is waiting on it, and
   * dropping it here would strand them.
   */
  forgetAncestorsOf(remoteFilePath: string): void {
    for (const ancestor of ancestorsOf(remoteFilePath)) this.proven.delete(ancestor);
  }

  /**
   * Forget every proven path. Used when the vault folder turns out to have been absent (a MKCOL of it
   * answered 201), which makes every "already created" entry underneath it a lie.
   *
   * In-flight MKCOLs are untouched for the same reason as in {@link forgetAncestorsOf}; if one of
   * them succeeds it re-proves its own path, which is correct — it really did just create it.
   */
  clear(): void {
    this.proven.clear();
  }
}

/** Every ancestor collection of a remote FILE path, from the outermost inwards (the file name is dropped). */
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
