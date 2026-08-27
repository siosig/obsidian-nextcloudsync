// Post-write stat signature stamping, lifted out of SyncEngine (feature 074, Phase 3).
//
// The plan for this feature listed `withLocalSignature` as NOT extractable, on the grounds that it
// re-stats the file and therefore has a side effect. That reasoning was too coarse: a side effect
// disqualifies something from `sync/policy` (pure predicates), not from being a module at all. As a
// free function that takes the adapter explicitly, the effect is visible in the signature rather than
// hidden behind `this`, and every caller — the engine, transfer, conflict resolution — reaches it the
// same way.
import { FileState } from '../types';
import { LocalAdapter } from './LocalAdapter';

/**
 * Stamp the post-write local stat signature (and optional remoteMtime) onto a FileState by
 * re-stat-ing the on-disk file. This captures what the OS actually wrote — the only reliable
 * change-detection key on mobile (no utimes). Call at every content-write / converge site so the
 * next sync's fast-path recognises the file as unchanged. Best-effort: if stat fails, the fields
 * stay undefined and the file is simply hashed next time (correct, just not fast).
 */
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
