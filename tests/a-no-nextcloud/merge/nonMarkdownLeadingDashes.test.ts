import { MergeEngine } from '../../../src/sync/merge/MergeEngine';
import { MergeContext } from '../../../src/types';

// Bug G3-3: MergeEngine.merge() is the NON-markdown whole-file entry (ConflictResolver.decideMerge
// only reaches it when !isMarkdown(path)). It must NOT split a leading `---...---` block off as YAML
// frontmatter — a non-markdown file's `---` block is not guaranteed to be YAML, and the old
// frontmatter path fell back to a silent whole-side pick that could DISCARD a one-sided edit inside
// that block instead of diff3-merging it like the rest of the file.
describe('[G3-3] MergeEngine.merge() never treats a leading --- block as frontmatter (non-markdown)', () => {
  const engine = new MergeEngine();

  it('a one-sided edit inside a leading --- block is 3-way merged, not discarded by a whole-side pick', () => {
    // A non-markdown file (e.g. a source/config file) whose leading `---` block is NOT valid YAML.
    // local edits INSIDE that block (fn old -> fn NEW); remote edits only the body (Body -> BODY2).
    const base = '---\nfn old\n---\nBody';
    const local = '---\nfn NEW\n---\nBody';
    const remote = '---\nfn old\n---\nBODY2';
    // remote newer: under the OLD frontmatter path an unparseable-YAML clash picked the whole newer
    // (remote) side, silently dropping local's `fn NEW`. The body 3-way merge keeps both edits.
    const ctx: MergeContext = { localMtime: 0, remoteMtime: 9999, conflictStrategy: 'conflict-markers' };
    const result = engine.merge(base, local, remote, ctx);
    expect(result.success).toBe(true);
    expect(result.mergedContent).toContain('fn NEW'); // local's in-block edit is NOT discarded
    expect(result.mergedContent).toContain('BODY2');   // remote's body edit is kept
    expect(result.hadConflicts).toBe(false);           // disjoint edits merge cleanly
  });

  it('a --- block edited on only one side keeps that edit even when the body is unchanged', () => {
    const base = '---\nx=1\n---\nsame';
    const local = '---\nx=2\n---\nsame';
    const remote = base;
    const ctx: MergeContext = { localMtime: 0, remoteMtime: 9999, conflictStrategy: 'conflict-markers' };
    const result = engine.merge(base, local, remote, ctx);
    expect(result.mergedContent).toContain('x=2'); // local's edit propagates; not overwritten by remote
  });
});
