// Decides which files get a 3-way merge base recorded and pairs every store write with a save request.
import { MergeBaseStore } from '../../data/MergeBaseStore';
import { isAutoMergeFileType, isMarkdown } from '../../util/mergeableExtensions';

export interface MergeBaseRecorderDeps {
  // Absent when no base store is injected: every method then no-ops.
  baseStore?: Pick<MergeBaseStore, 'set' | 'delete' | 'requestSave'>;
  // The configured Auto Merge File types, read at call time (settings can change).
  autoMergeFileTypes(): readonly string[];
}

export class MergeBaseRecorder {
  constructor(private readonly deps: MergeBaseRecorderDeps) {}

  record(path: string, content: string | ArrayBuffer): void {
    if (!this.deps.baseStore) return;
    // Every Auto Merge File (body 3-way) and every markdown file (frontmatter set-merge needs a base to
    // detect deletions even when `md` is an Other File) gets a base.
    if (!isAutoMergeFileType(path, this.deps.autoMergeFileTypes()) && !isMarkdown(path)) return;
    // Decode only text files that actually need a merge base. Large binary attachments can exceed
    // V8's string limit even when their ArrayBuffer fits comfortably in memory.
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    this.deps.baseStore.set(path, text);
    this.deps.baseStore.requestSave();
  }

  // Dropped on deletion so the base does not leak.
  drop(path: string): void {
    if (!this.deps.baseStore) return;
    this.deps.baseStore.delete(path);
    this.deps.baseStore.requestSave();
  }
}
