// Merge-base bookkeeping, lifted out of SyncEngine (feature 074, Phase 3).
//
// Decides WHICH files get a 3-way merge base recorded, and keeps the store's save requests in one
// place. The store itself (MergeBaseStore) already exists; what lived in SyncEngine was the eligibility
// rule and the save-request pairing, called from every convergence point — download, first upload,
// clean merge, prefer-local, prefer-remote — and dropped at every deletion.
//
// Extracted because transfer and conflict resolution both need it, and neither should have to reach
// back into the engine to record a base.
import { MergeBaseStore } from '../../data/MergeBaseStore';
import { isAutoMergeFileType, isMarkdown } from '../../util/mergeableExtensions';

export interface MergeBaseRecorderDeps {
  /** Absent when no base store is injected — every method then no-ops. */
  baseStore?: Pick<MergeBaseStore, 'set' | 'delete' | 'requestSave'>;
  /** The configured Auto Merge File types, read at call time (settings can change). */
  autoMergeFileTypes(): readonly string[];
}

export class MergeBaseRecorder {
  constructor(private readonly deps: MergeBaseRecorderDeps) {}

  /** Record `content` as the new 3-way base for `path`, when the file type has one. */
  record(path: string, content: string): void {
    if (!this.deps.baseStore) return;
    // Feature 047 (FR-015): record a base for every Auto Merge File (body 3-way) AND every markdown
    // file (frontmatter set-merge needs a base to detect deletions even when `md` is an Other File).
    if (!isAutoMergeFileType(path, this.deps.autoMergeFileTypes()) && !isMarkdown(path)) return;
    this.deps.baseStore.set(path, content);
    this.deps.baseStore.requestSave();
  }

  /** Drop the merge base for `path` on deletion so it does not leak (feature 038, FR-004). */
  drop(path: string): void {
    if (!this.deps.baseStore) return;
    this.deps.baseStore.delete(path);
    this.deps.baseStore.requestSave();
  }
}
