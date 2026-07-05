// Feature 048: two-level conflict resolution. A primary `merge` strategy that hits a genuine conflict
// (body diff3 region, or frontmatter scalar clash) defers THAT part to conflictStrategy. Deterministic
// primaries never conflict, so conflictStrategy is inert for them. Real reconcile/diff3 (no merge mocks).
import { ConflictResolver, MergeConfig, ConflictContext } from '../../../src/sync/ConflictResolver';
import { SyncStrategy, ConflictStrategy } from '../../../src/types';
import type { App } from 'obsidian';
import type { LocalAdapter } from '../../../src/data/LocalAdapter';

function makeConfig(over: Partial<MergeConfig>): MergeConfig {
  return {
    autoMergeFileTypes: ['txt'],
    autoMergeFileStrategy: 'merge',
    otherFileStrategy: 'latest-mtime',
    frontmatterStrategy: 'merge',
    conflictStrategy: 'conflict-markers',
    deviceId: 'dev-abcd',
    ...over,
  };
}
function resolver(over: Partial<MergeConfig> = {}): ConflictResolver {
  return new ConflictResolver({} as App, {} as unknown as LocalAdapter, makeConfig(over));
}
const ctx = (o: Partial<ConflictContext> = {}): ConflictContext => ({
  localSize: 100, remoteSize: 100, localMtime: 1000, remoteMtime: 1000, ...o,
});
function asWrite(r: ReturnType<ConflictResolver['decide']>): { content: string; clean: boolean } {
  if (r.action !== 'write') throw new Error(`expected write, got ${r.action}`);
  return { content: r.content, clean: r.clean };
}
const hasMarkers = (s: string): boolean => /^<<<<<<< LOCAL/m.test(s);

// A body conflict on line 2 (both changed the same line against a real base) + non-conflicting line 3
// (only local adds it) so we can prove non-conflicting parts still merge.
const BASE = 'shared\nBASE LINE';
const LOCAL = 'shared\nLOCAL LINE\nLOCAL EXTRA';
const REMOTE = 'shared\nREMOTE LINE';

describe('feature 048 — body conflict resolved per-region by conflictStrategy', () => {
  const cases: Array<{ cs: ConflictStrategy; expect: 'markers' | 'local' | 'remote' }> = [
    { cs: 'conflict-markers', expect: 'markers' },
    { cs: 'local-win', expect: 'local' },
    { cs: 'remote-win', expect: 'remote' },
  ];
  it.each(cases)('[SPEC:CF-14] body merge conflict with conflictStrategy=$cs', ({ cs, expect: exp }) => {
    const w = asWrite(resolver({ autoMergeFileStrategy: 'merge', conflictStrategy: cs })
      .decide('n.txt', BASE, LOCAL, REMOTE, ctx({ localMtime: 2, remoteMtime: 1 })));
    if (exp === 'markers') {
      expect(w.clean).toBe(false);
      expect(hasMarkers(w.content)).toBe(true);
      expect(w.content).toContain('LOCAL LINE');
      expect(w.content).toContain('REMOTE LINE');
    } else {
      expect(w.clean).toBe(true);
      expect(hasMarkers(w.content)).toBe(false);
      expect(w.content).toContain(exp === 'local' ? 'LOCAL LINE' : 'REMOTE LINE');
      expect(w.content).not.toContain(exp === 'local' ? 'REMOTE LINE' : 'LOCAL LINE');
    }
    // Non-conflicting shared line always survives.
    expect(w.content).toContain('shared');
  });

  it('[feat048 SC-006] conflictStrategy is inert when the primary strategy is deterministic', () => {
    // A non-md file under autoMergeFileStrategy=latest-mtime is a deterministic whole-file pick (a
    // prefer-local action, newer side) — never a conflict, so conflictStrategy=remote-win is unused.
    const d = resolver({ autoMergeFileStrategy: 'latest-mtime', conflictStrategy: 'remote-win' })
      .decide('n.txt', BASE, LOCAL, REMOTE, ctx({ localMtime: 9, remoteMtime: 1 }));
    expect(d.action).toBe('prefer-local');
  });

  it('[feat048 SC-001] non-conflicting edits clean-merge regardless of conflictStrategy', () => {
    const w = asWrite(resolver({ conflictStrategy: 'remote-win' })
      .decide('n.txt', 'l1\nl2\nl3', 'L1\nl2\nl3', 'l1\nl2\nL3', ctx()));
    expect(w.clean).toBe(true);
    expect(w.content).toContain('L1');
    expect(w.content).toContain('L3');
  });
});

describe('feature 048 — frontmatter scalar clash resolved by conflictStrategy (per-field)', () => {
  const base = '---\ntitle: base\ntags:\n  - t0\n---\nbody';
  const local = '---\ntitle: LOCAL\ntags:\n  - t0\n  - tl\n---\nbody';
  const remote = '---\ntitle: REMOTE\ntags:\n  - t0\n  - tr\n---\nbody';

  it('remote-win: the clashing scalar takes remote, arrays STILL union', () => {
    const w = asWrite(resolver({ frontmatterStrategy: 'merge', conflictStrategy: 'remote-win' })
      .decide('n.md', base, local, remote, ctx()));
    const fm = w.content.slice(0, w.content.indexOf('---', 3) + 3);
    expect(fm).toContain('title: REMOTE');
    expect(fm).not.toContain('title: LOCAL');
    expect(fm).toContain('tl'); // union preserved
    expect(fm).toContain('tr');
    expect(hasMarkers(fm)).toBe(false); // never markers in frontmatter
    expect(w.clean).toBe(true); // frontmatter clash resolved deterministically, body identical → clean
  });

  it('conflict-markers falls back to latest-mtime for a frontmatter clash (no markers in ---)', () => {
    const w = asWrite(resolver({ frontmatterStrategy: 'merge', conflictStrategy: 'conflict-markers' })
      .decide('n.md', base, local, remote, ctx({ localMtime: 9, remoteMtime: 1 })));
    const fm = w.content.slice(0, w.content.indexOf('---', 3) + 3);
    expect(hasMarkers(fm)).toBe(false);
    expect(fm).toContain('title: LOCAL'); // local newer → latest-mtime fallback
  });
});

describe('feature 048 — per-file-type dispatch', () => {
  it('[feat048 FR-002-004] md=fm+body, txt=whole autoMergeFileStrategy, png=otherFileStrategy', () => {
    const r = resolver({ autoMergeFileTypes: ['txt'], autoMergeFileStrategy: 'merge', otherFileStrategy: 'latest-mtime', frontmatterStrategy: 'remote-win', conflictStrategy: 'remote-win' });
    // md: frontmatter=remote-win (whole), body=merge. Give fm+body divergence with a real base.
    const md = asWrite(r.decide('note.md', '---\ntitle: b\n---\nshared\nBASE', '---\ntitle: L\n---\nshared\nLOCAL', '---\ntitle: R\n---\nshared\nREMOTE', ctx({ localMtime: 2, remoteMtime: 1 })));
    expect(md.content).toContain('title: R'); // frontmatter remote-win
    expect(md.content).toContain('REMOTE'); // body conflict → conflictStrategy remote-win
    // txt: whole file via autoMergeFileStrategy=merge; body conflict → remote-win.
    const txt = asWrite(r.decide('n.txt', BASE, LOCAL, REMOTE, ctx()));
    expect(txt.content).toContain('REMOTE LINE');
    // png: otherFileStrategy=latest-mtime → prefer newer (deterministic action, not a write).
    expect(r.decide('img.png', '', '', '', ctx({ localMtime: 9, remoteMtime: 1 })).action).toBe('prefer-local');
  });

  it('[feat048 FR-002] md is special-cased even when NOT in autoMergeFileTypes', () => {
    // autoMergeFileTypes empty → md body must still use autoMergeFileStrategy (not otherFileStrategy).
    const r = resolver({ autoMergeFileTypes: [], autoMergeFileStrategy: 'merge', otherFileStrategy: 'remote-win', conflictStrategy: 'local-win' });
    const md = asWrite(r.decide('note.md', BASE, LOCAL, REMOTE, ctx({ localMtime: 2, remoteMtime: 1 })));
    // body merged; conflict → conflictStrategy=local-win → LOCAL (not otherFileStrategy=remote-win).
    expect(md.content).toContain('LOCAL LINE');
    expect(md.content).not.toContain('REMOTE LINE');
  });
});
