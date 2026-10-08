import { FileState } from '../types';
import { LocalAdapter } from './LocalAdapter';

// Re-stats the file after a write: the post-write signature is the only reliable change-detection key on
// mobile (no utimes). Best-effort: if stat fails the fields stay undefined and the file is hashed next time.
export async function withLocalSignature(
  localAdapter: Pick<LocalAdapter, 'stat'>,
  fs: FileState,
  remoteMtime?: number | null,
): Promise<FileState> {
  const st = await localAdapter.stat(fs.path);
  if (st) {
    fs.localMtime = st.mtime;
    fs.localSize = st.size;
  }
  if (remoteMtime != null) fs.remoteMtime = remoteMtime;
  return fs;
}
