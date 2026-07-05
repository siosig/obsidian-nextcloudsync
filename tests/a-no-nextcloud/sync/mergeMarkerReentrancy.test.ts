// Feature 039 (MM-*): stop the conflict-marker RE-ENTRANCY loop and improve merge accuracy.
// The REAL reconcile-text + node-diff3 run here (no mocks), so this validates true end-to-end
// ConflictResolver/MergeEngine behaviour. Builds on feature 038 (real merge base).
//
// Root bug reproduced: a file already containing this plugin's conflict markers was fed back into the
// merge, which wrapped the existing markers in NEW markers and duplicated shared blocks — geometric
// growth (a real 62KB / 3-deep-marker / 12x-duplication casualty drove this feature).
import { ConflictResolver, MergeConfig } from '../../../src/sync/ConflictResolver';
import { hasNestedConflictMarkers } from '../../../src/sync/merge/MergeEngine';
import { SyncStrategy } from '../../../src/types';
import type { App } from 'obsidian';
import type { LocalAdapter } from '../../../src/data/LocalAdapter';

function makeConfig(
  autoMergeFileStrategy: SyncStrategy = 'merge',
  otherFileStrategy: Exclude<SyncStrategy, 'merge'> = 'latest-mtime',
  autoMergeFileTypes: string[] = ['md', 'txt'],
): MergeConfig {
  return { autoMergeFileTypes, autoMergeFileStrategy, otherFileStrategy, deviceId: 'dev-abcd', frontmatterStrategy: 'merge', conflictStrategy: 'conflict-markers' };
}

function resolver(cfg: MergeConfig = makeConfig()): ConflictResolver {
  return new ConflictResolver({} as App, {} as unknown as LocalAdapter, cfg);
}

// A document already carrying this plugin's full-file conflict markers (the re-entrancy input).
const MARKED =
  '<<<<<<< LOCAL (abcd, 2026-06-30)\n' +
  'shared line 1\nlocal edit\n' +
  '=======\n' +
  'shared line 1\nremote edit\n' +
  '>>>>>>> REMOTE (2026-06-30)\n';

const markerDepth = (s: string): number => (s.match(/^<<<<<<< LOCAL/gm) || []).length;

describe('[SPEC:MM-1..MM-5] marker re-entrancy guard (feature 039, P1)', () => {
  it('[SPEC:MM-1] LOCAL already contains plugin markers → safe-hold (no write, no re-wrap)', () => {
    const d = resolver().decide('note.md', '', MARKED, 'a clean remote body');
    expect(d).toEqual({ action: 'safe-hold' });
  });

  it('[SPEC:MM-2] REMOTE already contains plugin markers → safe-hold', () => {
    const d = resolver().decide('note.md', '', 'a clean local body', MARKED);
    expect(d).toEqual({ action: 'safe-hold' });
  });

  it('[SPEC:MM-3] self-healing: once markers are removed, the merge resumes and stays single-level', () => {
    // After the user resolves (removes markers), the inputs are clean again → normal 3-way merge.
    const d = resolver().decide('note.md', 'base\nshared', 'base\nshared\nlocal', 'base\nshared\nremote');
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(markerDepth(d.content)).toBeLessThanOrEqual(1); // never deeper than a single conflict
    }
  });

  it('[SPEC:MM-4] BOTH sides carry markers → safe-hold (never wrap markers in markers)', () => {
    const other =
      '<<<<<<< LOCAL (ef01, 2026-06-30)\nx\n=======\ny\n>>>>>>> REMOTE (2026-06-30)\n';
    const d = resolver().decide('note.md', '', MARKED, other);
    expect(d).toEqual({ action: 'safe-hold' });
  });

  it('[SPEC:MM-5] no false positive: a bare git-style "<<<<<<< HEAD" in prose is NOT treated as re-entrant', () => {
    // FR-039-4: the guard fires only on THIS plugin's markers (^<<<<<<< LOCAL / ^>>>>>>> REMOTE),
    // not on arbitrary `<<<<<<< something` a user may legitimately write in a note.
    const local = 'tutorial\n<<<<<<< HEAD\nour change\nline';
    const remote = 'tutorial\n<<<<<<< HEAD\ntheir change\nline';
    const d = resolver().decide('note.md', '', local, remote);
    expect(d.action).toBe('write'); // normal merge path, NOT safe-hold
  });
});

describe('[SPEC:MM-6..MM-7] nested-marker backstop (feature 039, P2)', () => {
  it('[SPEC:MM-6] detects STACKED plugin markers (a second LOCAL open before the REMOTE close)', () => {
    const nested =
      '<<<<<<< LOCAL (abcd, 2026-06-30)\n' +
      '<<<<<<< LOCAL (abcd, 2026-06-30)\n' + // re-wrapped: second open before any close
      'body\n' +
      '=======\n' +
      'other\n' +
      '>>>>>>> REMOTE (2026-06-30)\n';
    expect(hasNestedConflictMarkers(nested)).toBe(true);
  });

  it('[SPEC:MM-7] no false positive: a single well-formed conflict region is NOT nested', () => {
    const single =
      '<<<<<<< LOCAL (abcd, 2026-06-30)\nlocal\n=======\nremote\n>>>>>>> REMOTE (2026-06-30)\n';
    expect(hasNestedConflictMarkers(single)).toBe(false);
    // And a note that merely mentions a git marker line is not nested.
    expect(hasNestedConflictMarkers('intro\n<<<<<<< HEAD\nx\nplain prose')).toBe(false);
  });
});

describe('[SPEC:MM-8..MM-10] base-aware 3-way merge (feature 039, P3)', () => {
  it('[SPEC:MM-8] real base + non-overlapping line edits → clean merge keeping BOTH, no markers', () => {
    const d = resolver().decide(
      'note.md',
      'line1\nshared\nline3',          // base
      'line1\nshared\nLOCAL EDIT',     // local changed line3
      'REMOTE EDIT\nshared\nline3',    // remote changed line1
    );
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(d.clean).toBe(true);
      expect(d.content).toContain('LOCAL EDIT');
      expect(d.content).toContain('REMOTE EDIT');
      expect(d.content).not.toContain('<<<<<<< LOCAL'); // no conflict markers
    }
  });

  it('[SPEC:MM-9] real base + SAME line edited differently → single-level conflict markers', () => {
    const d = resolver().decide(
      'note.md',
      'line1\nshared line\nline3',     // base
      'line1\nLOCAL version\nline3',   // local changed line2
      'line1\nREMOTE version\nline3',  // remote changed the SAME line2
    );
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(d.clean).toBe(false);                       // a real conflict
      expect((d.content.match(/^<<<<<<< LOCAL/gm) || []).length).toBe(1); // exactly one region
      expect(d.content).toContain('LOCAL version');
      expect(d.content).toContain('REMOTE version');
    }
  });

  it('[SPEC:MM-10] empty base (migration) still merges via the legacy path without crashing', () => {
    const d = resolver().decide('note.md', '', 'line1\nLOCAL\nline3', 'line1\nline3\nREMOTE');
    expect(d.action).toBe('write');
  });
});

// Feature 041 (OM-*): a LONE half-marker left by an incomplete manual resolution must NOT be treated
// as re-entrant. Feature 039 dropped such files to a permanent safe-hold that never pushes, so the
// orphan line survived on the server and the file re-conflicted every sync forever (a real deadlock:
// a daily note ending in a bare `>>>>>>> REMOTE (…)` line). It must fall through to the normal merge,
// which converges to single-level output and (once pushed) removes the orphan — self-heal.
describe('[SPEC:OM-1..OM-4] orphan-marker self-heal (feature 041)', () => {
  const ORPHAN_CLOSE = 'shared body\nmore text\n>>>>>>> REMOTE (2026-06-30)\n';
  const ORPHAN_OPEN = '<<<<<<< LOCAL (abcd, 2026-06-30)\nshared body\nmore text\n';

  it('[SPEC:OM-1] LOCAL with a lone closing marker → NOT safe-hold, merges (self-heal)', () => {
    const d = resolver().decide('note.md', '', ORPHAN_CLOSE, 'shared body\nremote change\n');
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(markerDepth(d.content)).toBeLessThanOrEqual(1);
  });

  it('[SPEC:OM-2] LOCAL with a lone opening marker → NOT safe-hold, merges', () => {
    const d = resolver().decide('note.md', '', ORPHAN_OPEN, 'shared body\nremote change\n');
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(markerDepth(d.content)).toBeLessThanOrEqual(1);
  });

  it('[SPEC:OM-3] REMOTE with a lone closing marker → NOT safe-hold, merges', () => {
    const d = resolver().decide('note.md', '', 'shared body\nlocal change\n', ORPHAN_CLOSE);
    expect(d.action).toBe('write');
  });

  it('[SPEC:OM-4] convergence: identical orphan on both sides merges to a marker-free clean result', () => {
    // Both devices hold the same leftover orphan line and no other divergence → clean merge, and the
    // merged output no longer carries a plugin marker set (the orphan is plain text that survives once,
    // not re-wrapped). Pushing this converges both sides and clears the deadlock.
    const d = resolver().decide('note.md', 'shared body\n', ORPHAN_CLOSE, ORPHAN_CLOSE);
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(d.clean).toBe(true);
      expect(markerDepth(d.content)).toBeLessThanOrEqual(1);
    }
  });
});
