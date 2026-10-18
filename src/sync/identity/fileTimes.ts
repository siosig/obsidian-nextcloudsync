import { FileState, RemoteFileInfo } from '../../types';
import { LocalAdapter } from '../../data/LocalAdapter';
import { IWebDAVClient } from '../../network/IWebDAVClient';

export const timestampSecond = (value?: number | null): number | undefined =>
  value != null && Number.isFinite(value) && value > 0 ? Math.floor(value / 1000) : undefined;

export function timeDirection(local: number, remote: number, baseLocal?: number, baseRemote?: number): 'same' | 'push' | 'pull' {
  if (timestampSecond(local) === timestampSecond(remote)) return 'same';
  // With no metadata baseline, the existing server copy is authoritative.
  if (timestampSecond(baseLocal) == null || timestampSecond(baseRemote) == null) return 'pull';
  const localChanged = timestampSecond(local) !== timestampSecond(baseLocal);
  const remoteChanged = timestampSecond(remote) !== timestampSecond(baseRemote);
  if (localChanged && remoteChanged) throw new Error('Both sides changed the same timestamp; kept both and require conflict resolution');
  return localChanged ? 'push' : 'pull';
}

/** Called only when content identity has been established. Never guesses from clock order. */
export async function reconcileFileTimes(
  local: Pick<LocalAdapter, 'stat'> & Partial<Pick<LocalAdapter, 'setFileTimes'>>,
  client: IWebDAVClient, remote: RemoteFileInfo, base?: FileState,
): Promise<boolean> {
  const stat = await local.stat(remote.path);
  // Older/plain WebDAV metadata has no creation date. Preserve its legacy behaviour.
  if (!stat || timestampSecond(stat.ctime) == null || timestampSecond(remote.creationTime) == null) return false;
  if (timestampSecond(stat.mtime) !== timestampSecond(remote.lastModified)
      || timestampSecond(stat.ctime) !== timestampSecond(remote.creationTime)) {
    const fresh = await client.statFile(remote.path);
    if (!fresh) throw new Error(`File disappeared before timestamp reconciliation: ${remote.path}`);
    const sameChecksum = !!remote.checksum && fresh.checksum === remote.checksum;
    const sameEtag = !!remote.etag && fresh.etag === remote.etag;
    const differentChecksum = !!remote.checksum && !!fresh.checksum && fresh.checksum !== remote.checksum;
    if (fresh.size !== remote.size || differentChecksum || (!sameChecksum && !sameEtag)) {
      throw new Error(`Remote content changed before timestamp reconciliation: ${remote.path}`);
    }
    Object.assign(remote, fresh);
  }
  const mtime = timeDirection(stat.mtime, remote.lastModified, base?.localMtime, base?.remoteMtime ?? base?.mtime);
  const ctime = timeDirection(stat.ctime!, remote.creationTime!, base?.localCtime, base?.remoteCtime);
  if (mtime === 'same' && ctime === 'same') return false;
  const wanted = {
    mtime: mtime === 'pull' ? remote.lastModified : stat.mtime,
    ctime: ctime === 'pull' ? remote.creationTime! : stat.ctime!,
  };
  // Apply server changes first with the observed ETag; a concurrent remote edit must not change local timestamps.
  if (mtime === 'push' || ctime === 'push') {
    if (!client.setFileTimes) throw new Error(`Server client cannot preserve file timestamps: ${remote.path}`);
    Object.assign(remote, await client.setFileTimes(remote.path, wanted, remote.etag));
  }
  if (mtime === 'pull' || ctime === 'pull') {
    if (!local.setFileTimes) throw new Error(`Local adapter cannot preserve file timestamps: ${remote.path}`);
    await local.setFileTimes(remote.path, wanted);
  }
  return true;
}
