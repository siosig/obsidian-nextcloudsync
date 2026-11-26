import { FileState } from '../types';
import { LocalAdapter } from './LocalAdapter';

/** The two stat fields that make up the change-detection signature. */
export interface LocalSignature {
  readonly mtime: number;
  readonly size: number;
}

// Re-stats the file right after THIS device wrote it (download, conflict write, restore): the post-write stat is the
// change-detection key. Only valid immediately after the plugin's own write, never after reading bytes to hash or upload
// them: there a signature must come from a stat taken BEFORE the read (withPreReadSignature, docs/plan.md §7.4).
// Best-effort: if stat fails the fields stay undefined and the file is hashed next time.
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

/**
 * Stamps a signature taken BEFORE the read that produced fs.localHash, so it is never newer than the hashed bytes.
 * Pure: returns a new object and leaves `fs` untouched (docs/spec.md §5.3b, docs/plan.md §7.4).
 */
export function withPreReadSignature(
  fs: FileState,
  sig: LocalSignature,
  remoteMtime?: number | null,
): FileState {
  const out: FileState = { ...fs, localMtime: sig.mtime, localSize: sig.size };
  if (remoteMtime != null) out.remoteMtime = remoteMtime;
  return out;
}

/**
 * Drops the signature so the next sync reads and hashes the file. Pure: returns a new object. The keys stay present
 * (set to undefined, not deleted) to keep the object shape stable.
 */
export function withoutLocalSignature(fs: FileState): FileState {
  return { ...fs, localMtime: undefined, localSize: undefined };
}
