import { FileState, RemoteFileInfo } from '../../types';
import { remoteIdOf } from '../remoteIdentity';

// True when the server-side SHA-256 proves the remote body equals a local body with this hash (docs/spec.md §5.3a).
// An ETag or a size never proves identity.
export function checksumProvesIdentical(remote: Pick<RemoteFileInfo, 'checksum'>, localHash: string): boolean {
  return !!remote.checksum && localHash.length > 0 && remote.checksum === localHash;
}

export function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// The baseline for a file whose local and remote bodies are proven identical. The caller adds the stat signature.
export function convergedState(
  remote: RemoteFileInfo, localHash: string, localStat: { size: number; mtime: number },
): FileState {
  const { remoteId, idType } = remoteIdOf(remote);
  return {
    path: remote.path, localHash, remoteId, idType,
    size: localStat.size, mtime: remote.lastModified || localStat.mtime,
    remoteFileId: remote.fileId, isConflicted: false,
  };
}
