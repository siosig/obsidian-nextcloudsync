import { ConflictResolver, MergeConfig, ConflictContext, isLikelyBinary } from '../../../src/sync/ConflictResolver';
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
  return { autoMergeFileTypes, autoMergeFileStrategy, otherFileStrategy, deviceId: 'test-dev-abcd' };
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
    const d = r.decide('notes.md', '', 'local', 'remote');
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(true);
  });

  it('CSF-3 diverging frontmatter -> write conflict markers { clean: false }', () => {
    const r = makeResolver(makeConfig('merge'));
    const d = r.decide('notes.md', '', FM_LOCAL, FM_REMOTE);
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(d.clean).toBe(false);
      expect(d.content).toContain('<<<<<<< LOCAL');
      expect(d.content).toContain('>>>>>>> REMOTE');
    }
  });

  it('CSF-4 non-text under merge -> safe-hold (no markers written)', () => {
    const r = makeResolver(makeConfig('merge', 'latest-mtime', ['png']));
    expect(r.decide('image.png', '', binLocal, binRemote)).toEqual({ action: 'safe-hold' });
  });
});

describe('ConflictResolver.decide — deterministic strategies', () => {
  it('CSF-8 local-win -> prefer-local; remote-win -> prefer-remote', () => {
    expect(makeResolver(makeConfig('local-win')).decide('n.md', '', 'a', 'b')).toEqual({ action: 'prefer-local' });
    expect(makeResolver(makeConfig('remote-win')).decide('n.md', '', 'a', 'b')).toEqual({ action: 'prefer-remote' });
  });

  it('CSF-6 biggest-size -> larger side', () => {
    const r = makeResolver(makeConfig('biggest-size'));
    expect(r.decide('n.md', '', '', '', ctx({ localSize: 200, remoteSize: 100 }))).toEqual({ action: 'prefer-local' });
    expect(r.decide('n.md', '', '', '', ctx({ localSize: 100, remoteSize: 200 }))).toEqual({ action: 'prefer-remote' });
  });

  it('CSF-7 latest-mtime -> newer side', () => {
    const r = makeResolver(makeConfig('latest-mtime'));
    expect(r.decide('n.md', '', '', '', ctx({ localMtime: 3000, remoteMtime: 1000 }))).toEqual({ action: 'prefer-local' });
    expect(r.decide('n.md', '', '', '', ctx({ localMtime: 1000, remoteMtime: 3000 }))).toEqual({ action: 'prefer-remote' });
  });

  it('CSF-9 tie (equal size / equal mtime) -> no-op', () => {
    expect(makeResolver(makeConfig('biggest-size')).decide('n.md', '', '', '', ctx({ localSize: 50, remoteSize: 50 }))).toEqual({ action: 'no-op' });
    expect(makeResolver(makeConfig('latest-mtime')).decide('n.md', '', '', '', ctx({ localMtime: 7, remoteMtime: 7 }))).toEqual({ action: 'no-op' });
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
    const resolved = await r.resolve('notes.md', '', 'local', 'remote');
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
