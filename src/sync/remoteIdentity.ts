import { FileState, RemoteFileInfo } from '../types';

// Single definition of the remote identity: checksum, else ETag, else size. Recording and classifying
// must share it, or a plain WebDAV server reads every uploaded file back as changed (docs/spec.md §5.9).
export function remoteIdOf(remote: RemoteFileInfo): { remoteId: string; idType: FileState['idType'] } {
  if (remote.checksum) return { remoteId: remote.checksum, idType: 'sha256' };
  if (remote.etag) return { remoteId: remote.etag, idType: 'etag' };
  return { remoteId: String(remote.size), idType: 'size' };
}
