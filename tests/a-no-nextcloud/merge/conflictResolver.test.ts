import { ConflictResolver, MergeConfig, ConflictContext, isLikelyBinary, hasCompleteMarkerSet, hasOrphanMarker } from '../../../src/sync/ConflictResolver';
import { SyncStrategy } from '../../../src/types';
import { App, DataAdapter } from 'obsidian';

// reconcile-text returns a {text} object; a clean merge here is local+remote (CRDT-style union).
jest.mock('reconcile-text', () => ({
  reconcile: (_b: string, l: string, r: string) => ({ text: l === r ? l : l + r }),
}));
// node-diff3's diff3Merge: any difference between the two sides is a conflict region.
jest.mock('node-diff3', () => ({
  diff3Merge: (a: string[], _o: string[], b: string[]) => (
    JSON.stringify(a) !== JSON.stringify(b) ? [{ conflict: { a, b } }] : [{ ok: a }]
  ),
}));

// Build binary-looking content at runtime (a NUL byte is the binary signal isLikelyBinary checks),
// keeping the source file pure ASCII.
const NUL = String.fromCharCode(0);
const REPL = String.fromCharCode(0xfffd);
const binLocal = `a${NUL}local`;
const binRemote = `b${NUL}remote`;

function makeApp(): App {
  return { vault: { adapter: {} } } as unknown as App;
}

function makeAdapter(store: Record<string, string> = {}): DataAdapter {
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    readBinary: jest.fn(),
    writeBinary: jest.fn(),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (from: string, to: string) => { store[to] = store[from]; delete store[from]; }),
    stat: jest.fn(),
    list: jest.fn(),
  } as unknown as DataAdapter;
}

// Feature 037: ConflictResolver takes a per-type strategy config. The test builds it directly so
// every classification / strategy branch stays independently exercised.
function makeConfig(
  autoMergeFileStrategy: SyncStrategy = 'merge',
  otherFileStrategy: Exclude<SyncStrategy, 'merge'> = 'latest-mtime',
  autoMergeFileTypes: string[] = ['md', 'txt'],
): MergeConfig {
  return { autoMergeFileTypes, autoMergeFileStrategy, otherFileStrategy, deviceId: 'test-dev-abcd', frontmatterStrategy: 'merge', conflictStrategy: 'conflict-markers' };
}

function makeResolver(config: MergeConfig, store: Record<string, string> = {}): ConflictResolver {
  const { LocalAdapter } = jest.requireActual('../../../src/data/LocalAdapter') as typeof import('../../../src/data/LocalAdapter');
  const adapter = new LocalAdapter(makeAdapter(store));
  return new ConflictResolver(makeApp(), adapter, config);
}

const ctx = (over: Partial<ConflictContext> = {}): ConflictContext => ({
  localSize: 100, remoteSize: 100, localMtime: 1000, remoteMtime: 1000, ...over,
});

// Frontmatter that diverges -> MergeEngine refuses -> non-clean merge (full-file markers).
const FM_LOCAL = '---\na: 1\n---\nbody';
const FM_REMOTE = '---\na: 2\n---\nbody';

describe('isLikelyBinary', () => {
  it('flags NUL and replacement-char content, passes plain text', () => {
    expect(isLikelyBinary('plain text\nwith lines')).toBe(false);
    expect(isLikelyBinary(`has${NUL}nul`)).toBe(true);
    expect(isLikelyBinary(`bad${REPL}decode`)).toBe(true);
  });
});

describe('ConflictResolver helpers', () => {
  it('hasConflictMarkers detects <<<<<<< marker', () => {
    const resolver = makeResolver(makeConfig());
    expect(resolver.hasConflictMarkers('<<<<<<< LOCAL\nfoo\n=======\nbar\n>>>>>>> REMOTE\n')).toBe(true);
    expect(resolver.hasConflictMarkers('Normal content')).toBe(false);
  });

  it('stripConflictTag removes #conflict tag', () => {
    const resolver = makeResolver(makeConfig());
    const result = resolver.stripConflictTag('Content\n#conflict\n');
    expect(result).not.toContain('#conflict');
    expect(result.trim()).toBe('Content');
  });
});

describe('ConflictResolver.isAutoMergeFile / strategyFor (CSF-1 classification)', () => {
  it('matches configured extensions case-insensitively', () => {
    const r = makeResolver(makeConfig('merge', 'latest-mtime', ['md', 'txt']));
    expect(r.isAutoMergeFile('notes.md')).toBe(true);
    expect(r.isAutoMergeFile('NOTES.MD')).toBe(true);
    expect(r.isAutoMergeFile('memo.txt')).toBe(true);
    expect(r.isAutoMergeFile('image.png')).toBe(false);
    expect(r.isAutoMergeFile('folder/sub/note.md')).toBe(true);
  });

  it('treats files without an extension as Other File', () => {
    const r = makeResolver(makeConfig());
    expect(r.isAutoMergeFile('LICENSE')).toBe(false);
    expect(r.isAutoMergeFile('archive.')).toBe(false);
    expect(r.isAutoMergeFile('.gitignore')).toBe(false); // leading-dot dotfile: the "ext" position guard
  });

  it('routes each side to its strategy; empty list -> all Other File', () => {
    const r = makeResolver(makeConfig('merge', 'biggest-size', ['md']));
    expect(r.strategyFor('a.md')).toBe('merge');
    expect(r.strategyFor('a.png')).toBe('biggest-size');
    const allOther = makeResolver(makeConfig('merge', 'latest-mtime', []));
    expect(allOther.strategyFor('a.md')).toBe('latest-mtime');
  });
});

describe('ConflictResolver.decide — merge strategy', () => {
  it('CSF-2 clean text merge -> write { clean: true }', () => {
    const r = makeResolver(makeConfig('merge'));
    // Non-conflicting empty-base union that PRESERVES line boundaries — reconcile joins 'A\n' + 'B\n'
    // into the two clean lines 'A','B' (CSF-2 contract: both sides kept, clean). Contrast the G3-1
    // fusion case, where 'local'+'remote' (no line break) fuse into one corrupted line → conflict.
    const d = r.decide('notes.md', '', 'A\n', 'B\n');
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(true);
  });

  it('CSF-3 diverging scalar frontmatter -> semantic merge (clean: true, feature 040)', () => {
    // Feature 040: scalar frontmatter conflicts are now resolved by policy instead of markers.
    // FM_LOCAL has a:1, FM_REMOTE has a:2, body is identical 'body'.
    // Policy defaults to remote-win (no ctx) → a:2, body unchanged → clean merge.
    const r = makeResolver(makeConfig('merge'));
    const d = r.decide('notes.md', '', FM_LOCAL, FM_REMOTE);
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(d.clean).toBe(true);
      expect(d.content).toContain('a: 2');
    }
  });

  it('CSF-4 non-text under merge -> safe-hold (no markers written)', () => {
    const r = makeResolver(makeConfig('merge', 'latest-mtime', ['png']));
    expect(r.decide('image.png', '', binLocal, binRemote)).toEqual({ action: 'safe-hold' });
  });
});

// Feature 041: only a COMPLETE plugin marker set is re-entrant; a lone half-marker (from an incomplete
// manual resolution) must fall through to a normal merge so it self-heals instead of dead-locking.
describe('ConflictResolver.decide — feature 041 orphan-marker self-heal', () => {
  const COMPLETE = '<<<<<<< LOCAL (abcd, 2026-06-30)\na\n=======\nb\n>>>>>>> REMOTE (2026-06-30)\n';
  const ORPHAN_CLOSE = 'body content\n>>>>>>> REMOTE (2026-06-30)\n';
  const ORPHAN_OPEN = '<<<<<<< LOCAL (abcd, 2026-06-30)\nbody content\n';

  it('lone closing marker -> NOT safe-hold (routed to merge)', () => {
    const r = makeResolver(makeConfig('merge'));
    // local carries an orphan closing marker, remote differs → merge decides (write), never safe-hold.
    expect(r.decide('notes.md', '', ORPHAN_CLOSE, 'different remote').action).toBe('write');
  });

  it('lone opening marker -> NOT safe-hold (routed to merge)', () => {
    const r = makeResolver(makeConfig('merge'));
    expect(r.decide('notes.md', '', ORPHAN_OPEN, 'different remote').action).toBe('write');
  });

  it('orphan on the REMOTE side is also routed to merge (not safe-hold)', () => {
    const r = makeResolver(makeConfig('merge'));
    expect(r.decide('notes.md', '', 'clean local', ORPHAN_CLOSE).action).toBe('write');
  });

  it('COMPLETE marker set -> still safe-hold (feature 039 preserved)', () => {
    const r = makeResolver(makeConfig('merge'));
    expect(r.decide('notes.md', '', COMPLETE, 'different remote')).toEqual({ action: 'safe-hold' });
  });

  it('legitimate `<<<<<<< HEAD` prose is neither complete nor orphan (no false safe-hold)', () => {
    const r = makeResolver(makeConfig('merge'));
    // A user note that literally contains git-style `<<<<<<< HEAD` must merge normally.
    expect(r.decide('notes.md', '', '<<<<<<< HEAD\nfoo', 'bar').action).toBe('write');
  });

  it('hasCompleteMarkerSet: both lines required', () => {
    expect(hasCompleteMarkerSet(COMPLETE)).toBe(true);
    expect(hasCompleteMarkerSet(ORPHAN_CLOSE)).toBe(false);
    expect(hasCompleteMarkerSet(ORPHAN_OPEN)).toBe(false);
    expect(hasCompleteMarkerSet('<<<<<<< HEAD\nfoo')).toBe(false);
    expect(hasCompleteMarkerSet('plain text')).toBe(false);
  });

  it('hasOrphanMarker: exactly one marker line (XOR)', () => {
    expect(hasOrphanMarker(ORPHAN_CLOSE)).toBe(true);
    expect(hasOrphanMarker(ORPHAN_OPEN)).toBe(true);
    expect(hasOrphanMarker(COMPLETE)).toBe(false);
    expect(hasOrphanMarker('plain text')).toBe(false);
    expect(hasOrphanMarker('<<<<<<< HEAD\nfoo')).toBe(false);
  });
});

describe('ConflictResolver.decide — deterministic strategies', () => {
  it('CSF-8 local-win -> prefer-local; remote-win -> prefer-remote', () => {
    expect(makeResolver(makeConfig('local-win')).decide('n.txt', '', 'a', 'b')).toEqual({ action: 'prefer-local' });
    expect(makeResolver(makeConfig('remote-win')).decide('n.txt', '', 'a', 'b')).toEqual({ action: 'prefer-remote' });
  });

  it('CSF-6 biggest-size -> larger side', () => {
    const r = makeResolver(makeConfig('biggest-size'));
    expect(r.decide('n.txt', '', '', '', ctx({ localSize: 200, remoteSize: 100 }))).toEqual({ action: 'prefer-local' });
    expect(r.decide('n.txt', '', '', '', ctx({ localSize: 100, remoteSize: 200 }))).toEqual({ action: 'prefer-remote' });
  });

  it('CSF-7 latest-mtime -> newer side', () => {
    const r = makeResolver(makeConfig('latest-mtime'));
    expect(r.decide('n.txt', '', '', '', ctx({ localMtime: 3000, remoteMtime: 1000 }))).toEqual({ action: 'prefer-local' });
    expect(r.decide('n.txt', '', '', '', ctx({ localMtime: 1000, remoteMtime: 3000 }))).toEqual({ action: 'prefer-remote' });
  });

  it('CSF-9 tie (equal size / equal mtime) -> no-op', () => {
    expect(makeResolver(makeConfig('biggest-size')).decide('n.txt', '', '', '', ctx({ localSize: 50, remoteSize: 50 }))).toEqual({ action: 'no-op' });
    expect(makeResolver(makeConfig('latest-mtime')).decide('n.txt', '', '', '', ctx({ localMtime: 7, remoteMtime: 7 }))).toEqual({ action: 'no-op' });
  });
});

describe('ConflictResolver.computeResolution (pure resolved-content compute)', () => {
  it('safe-hold -> keeps local unchanged, clean=false', () => {
    const r = makeResolver(makeConfig('merge', 'latest-mtime', ['png']));
    const res = r.computeResolution('image.png', '', binLocal, binRemote);
    expect(res.content).toBe(binLocal);
    expect(res.clean).toBe(false);
  });
  it('prefer-local -> after = local, clean=true', () => {
    const r = makeResolver(makeConfig('merge', 'local-win')); // image.png = Other File → local-win
    const res = r.computeResolution('image.png', '', 'localX', 'remoteY');
    expect(res.content).toBe('localX');
    expect(res.clean).toBe(true);
  });
  it('prefer-remote -> after = remote, clean=true', () => {
    const r = makeResolver(makeConfig('merge', 'remote-win')); // image.png = Other File → remote-win
    const res = r.computeResolution('image.png', '', 'localX', 'remoteY');
    expect(res.content).toBe('remoteY');
    expect(res.clean).toBe(true);
  });
  it('no-op (tie) -> keeps local, clean=true', () => {
    const r = makeResolver(makeConfig('latest-mtime'));
    const res = r.computeResolution('image.png', '', 'localX', 'remoteY', ctx({ localMtime: 5, remoteMtime: 5 }));
    expect(res.content).toBe('localX');
    expect(res.clean).toBe(true);
  });
});

describe('ConflictResolver.resolve (local-side write)', () => {
  it('writes merged content to disk for a clean merge', async () => {
    const store: Record<string, string> = {};
    const r = makeResolver(makeConfig('merge'), store);
    // Non-conflicting disjoint edits on a shared base → a clean merged write (see CSF-2 note above).
    const resolved = await r.resolve('notes.md', '', 'A\n', 'B\n');
    expect(resolved).toBe(true);
    expect(store['notes.md']).toBeDefined();
  });

  it('does NOT write anything for safe-hold (non-text under merge)', async () => {
    const store: Record<string, string> = {};
    const r = makeResolver(makeConfig('merge', 'latest-mtime', ['png']), store);
    const resolved = await r.resolve('image.png', '', binLocal, binRemote);
    expect(resolved).toBe(false);
    expect(Object.keys(store)).toHaveLength(0);
  });
});
