// Aligns the creation time of a file whose body this sync did not change on the server (docs/spec.md §9.7).
// The decision is the pure planCreationTimeAlignment; this class only executes it and records the outcome.
// The WebDAV client is a PARAMETER, never a field: SyncEngine can replace it between syncs.
import type { FileState, RemoteFileInfo } from '../../types';
import type { LocalAdapter, LocalStat } from '../../data/LocalAdapter';
import type { StateDB } from '../../data/StateDB';
import { withoutLocalSignature } from '../../data/localSignature';
import type { IWebDAVClient } from '../../network/IWebDAVClient';
import type { FileLogger } from '../../util/FileLogger';
import { planCreationTimeAlignment } from '../../util/creationTime';

export interface CreationTimePort {
  /**
   * Aligns the creation time of one file whose body this sync did not change on the server (docs/spec.md §9.7).
   * No-op when remote.creationTime is undefined. Never throws.
   * @param localStat the caller's fresh stat; undefined = stat here; null = the file is absent (no-op)
   */
  align(client: IWebDAVClient, remote: RemoteFileInfo, localStat?: LocalStat | null): Promise<void>;
}

export interface CreationTimeAlignerDeps {
  localAdapter: Pick<LocalAdapter, 'stat' | 'setCreationTime' | 'creationTimeSupport'>;
  stateDB: Pick<StateDB, 'getFile' | 'setFile' | 'setRemoteRootEtag'>;
  isBeingEdited(path: string): boolean;
  logger?: Pick<FileLogger, 'log'>;
}

export class CreationTimeAligner implements CreationTimePort {
  constructor(private readonly deps: CreationTimeAlignerDeps) {}

  async align(client: IWebDAVClient, remote: RemoteFileInfo, localStat?: LocalStat | null): Promise<void> {
    try {
      if (remote.creationTime === undefined) return;
      const st = localStat === undefined ? await this.deps.localAdapter.stat(remote.path) : localStat;
      if (!st) return;
      const support = await this.deps.localAdapter.creationTimeSupport();
      const base = this.deps.stateDB.getFile(remote.path);
      const plan = planCreationTimeAlignment({
        localCtimeMs: st.ctime,
        remoteCreationTimeMs: remote.creationTime,
        localSettable: support === 'settable',
        localAttemptSeconds: base?.ctimeLocalAttempt,
        remoteAttemptSeconds: base?.ctimeRemoteAttempt,
      });
      if (plan.setLocalSeconds !== null) await this.alignLocal(remote.path, plan.setLocalSeconds);
      if (plan.setRemoteSeconds !== null) await this.alignRemote(client, remote.path, plan.setRemoteSeconds);
    } catch (e) {
      await this.log(`unexpected error (${errText(e)})`, remote.path);
    }
  }

  private async alignLocal(path: string, seconds: number): Promise<void> {
    const { localAdapter, stateDB } = this.deps;
    if (this.deps.isBeingEdited(path)) {
      await this.log('local fix deferred, file is being edited', path);
      stateDB.setRemoteRootEtag(null);
      return;
    }
    // Taken before the set: the recorded hash was read before this stat (docs/spec.md §5.3b).
    const pre = await localAdapter.stat(path);
    let result: 'applied' | 'ineffective' | 'absent';
    try {
      result = await localAdapter.setCreationTime(path, seconds * 1000);
    } catch (e) {
      await this.log(`local fix failed (${errText(e)}); not retried for ${seconds}`, path);
      this.patchState(path, (s) => ({ ...s, ctimeLocalAttempt: seconds }));
      return;
    }
    if (result === 'absent') return;
    if (result === 'ineffective') {
      await this.log(`local fix ineffective (${seconds}); not retried for this value`, path);
      this.patchState(path, (s) => ({ ...s, ctimeLocalAttempt: seconds }));
      return;
    }
    await this.log(`local set to ${seconds}`, path);
    const fresh = await localAdapter.stat(path);
    this.patchState(path, (s) => {
      const { ctimeLocalAttempt: _dropped, ...rest } = s;
      // docs/plan.md §7.4: the recorded hash was read before `pre`, so the record keeps its signature only when the file
      // did not change since the record and the set left it as `pre` (the set keeps mtime). A post-set stat that differs
      // may hide a save during the set, so drop the signature and let the next sync read the content.
      const unchanged = pre !== null && rest.localMtime === pre.mtime && rest.localSize === pre.size;
      if (!unchanged) return withoutLocalSignature(rest);
      const moved = fresh !== null && (fresh.mtime !== pre.mtime || fresh.size !== pre.size);
      return moved ? withoutLocalSignature(rest) : rest;
    });
  }

  private async alignRemote(client: IWebDAVClient, path: string, seconds: number): Promise<void> {
    const { stateDB } = this.deps;
    let result: 'applied' | 'rejected';
    try {
      result = await client.setCreationTime(path, seconds);
    } catch (e) {
      await this.log(`server update failed (${errText(e)}); rescan next sync`, path);
      stateDB.setRemoteRootEtag(null);
      return;
    }
    if (result === 'rejected') {
      await this.log(`server rejected ${seconds}; not retried for this value`, path);
      this.patchState(path, (s) => ({ ...s, ctimeRemoteAttempt: seconds }));
      return;
    }
    await this.log(`server set to ${seconds}`, path);
    this.patchState(path, (s) => {
      const { ctimeRemoteAttempt: _dropped, ...rest } = s;
      return rest;
    });
  }

  // Re-reads the state after the awaited I/O, so a concurrent update of the same path is not overwritten with a stale copy.
  private patchState(path: string, patch: (s: FileState) => FileState): void {
    const current = this.deps.stateDB.getFile(path);
    if (current) this.deps.stateDB.setFile(patch(current));
  }

  private async log(what: string, path: string): Promise<void> {
    try {
      await this.deps.logger?.log(`ctime: ${what} → ${path}`);
    } catch {
      // logging must never break a sync
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
