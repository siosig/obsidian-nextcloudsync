import { MergeEngine } from '../../../src/sync/merge/MergeEngine';
import { MergeContext } from '../../../src/types';

// Bug G3-1: on an empty merge base, reconcile-text can FUSE two divergent sides at the character
// level (destroying the line boundary between two independent edits) and report it as a clean merge.
// The length/repeated-block guards miss a pure concatenation; `linesSurvive` catches it and routes the
// case to a real conflict instead of silently persisting corrupted content. Uses the REAL
// reconcile-text (no mock) so it exercises the actual fusion.
describe('[G3-1] empty-base merge never silently fuses two divergent sides', () => {
  const engine = new MergeEngine();
  const markers: MergeContext = { localMtime: 0, remoteMtime: 0, conflictStrategy: 'conflict-markers' };

  it('character-level fusion of two single-line edits is flagged as a conflict, not accepted as clean', () => {
    // reconcile-text fuses these into 'Goodbye cruel old worldHello brave new world' (one line).
    const r = engine.merge('', 'Hello brave new world', 'Goodbye cruel old world', markers);
    expect(r.hadConflicts).toBe(true);                                  // NOT a clean merge
    expect(r.mergedContent).toContain('<<<<<<< LOCAL');                 // both sides surfaced via markers
    expect(r.mergedContent).not.toBe('Goodbye cruel old worldHello brave new world'); // never the fused line
  });

  it('a line-preserving empty-base union stays clean (both lines kept)', () => {
    const r = engine.merge('', 'A\n', 'B\n', markers);
    expect(r.hadConflicts).toBe(false);
    expect(r.mergedContent).toContain('A');
    expect(r.mergedContent).toContain('B');
    expect(r.mergedContent).not.toContain('<<<<<<<');
  });

  it('a multi-line union that keeps every line intact stays clean', () => {
    const r = engine.merge('', 'title\nlocalbody', 'title\nremotebody', markers);
    expect(r.hadConflicts).toBe(false);
    expect(r.mergedContent).toContain('localbody');
    expect(r.mergedContent).toContain('remotebody');
  });

  it('one side empty is a clean first-write (adopts the non-empty side), never a false conflict', () => {
    const r = engine.merge('', 'the only content', '', markers);
    expect(r.hadConflicts).toBe(false);
    expect(r.mergedContent).toBe('the only content');
    expect(r.mergedContent).not.toContain('<<<<<<<');
  });
});
