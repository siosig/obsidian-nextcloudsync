// Direct tests for LocalScanner (feature 074, Phase 2).
//
// No [SPEC:...] tags: EXCL-HARD-1 and CSF-12 are already claimed by the SyncEngine-level suites,
// which is also where the engine-to-module wiring is proven. What this file adds is a way to state
// the enumeration's own contract without a SyncEngine in the way.
//
// The subject here is the two-route enumeration. Vault.getFiles() omits EVERY dot-prefixed path
// while adapter.list() includes them, so the scanner walks both — and the temptation to "simplify"
// it onto the Vault index alone would silently stop syncing every dotfile in the vault. These tests
// exist mostly so that regression cannot pass unnoticed.
import { LocalScanner, LocalScanDeps } from '../../../../src/sync/scan/LocalScanner';

type Dir = { files: string[]; folders: string[] };

interface FakeFs {
  /** What Vault.getFiles() reports — never a dot path. */
  vault: Array<{ path: string; size: number; mtime: number }>;
  /** What adapter.list() reports, keyed by directory ('' is the vault root). */
  dirs: Record<string, Dir>;
  /** Sizes for adapter-listed files; anything missing here stats as null. */
  stats: Record<string, { size: number; mtime: number }>;
}

function build(fs: FakeFs, over: Partial<LocalScanDeps> = {}) {
  const listCalls: string[] = [];
  const deps: LocalScanDeps = {
    localAdapter: {
      listVaultFiles: () => fs.vault,
      list: async (dir: string) => {
        listCalls.push(dir);
        const d = fs.dirs[dir];
        if (!d) throw new Error(`ENOENT: ${dir}`);
        return d;
      },
      stat: async (p: string) => fs.stats[p] ?? null,
    } as unknown as LocalScanDeps['localAdapter'],
    isSystemExcluded: () => false,
    isUnderConfigDir: (p) => p === '.obsidian' || p.startsWith('.obsidian/'),
    enumerateIncludedConfigPaths: async () => [],
    ...over,
  };
  return { scanner: new LocalScanner(deps), listCalls };
}

/** A vault with one ordinary note, one root dotfile, and one dot folder holding a note. */
const FS: FakeFs = {
  vault: [{ path: 'notes/a.md', size: 10, mtime: 1 }],
  dirs: {
    '': { files: ['.env', 'notes/a.md'], folders: ['.archive', '.obsidian', 'notes'] },
    '.archive': { files: ['.archive/old.md'], folders: ['.archive/deep'] },
    '.archive/deep': { files: ['.archive/deep/older.md'], folders: [] },
  },
  stats: {
    '.env': { size: 2, mtime: 2 },
    '.archive/old.md': { size: 3, mtime: 3 },
    '.archive/deep/older.md': { size: 4, mtime: 4 },
  },
};

describe('LocalScanner.scanLocalFiles', () => {
  it('returns Vault-tracked files with their stats', async () => {
    const { scanner } = build(FS);
    expect((await scanner.scanLocalFiles()).get('notes/a.md')).toEqual({ size: 10, mtime: 1 });
  });

  it('recovers the dot paths the Vault index omits, recursively', async () => {
    const found = await (build(FS).scanner.scanLocalFiles());
    expect(found.get('.env')).toEqual({ size: 2, mtime: 2 });
    expect(found.get('.archive/old.md')).toEqual({ size: 3, mtime: 3 });
    expect(found.get('.archive/deep/older.md')).toEqual({ size: 4, mtime: 4 });
  });

  it('does not walk ordinary folders with the adapter — that is what the Vault index is for', async () => {
    const { scanner, listCalls } = build(FS);
    await scanner.scanLocalFiles();
    // The root has to be listed to find the dot entries; 'notes' must not be.
    expect(listCalls).toContain('');
    expect(listCalls).not.toContain('notes');
  });

  it('leaves the config folder to the config-sync route rather than walking into it', async () => {
    const { scanner, listCalls } = build(FS);
    await scanner.scanLocalFiles();
    expect(listCalls).not.toContain('.obsidian');
  });

  it('injects the config paths the caller reports as included', async () => {
    const { scanner } = build(
      { ...FS, stats: { ...FS.stats, '.obsidian/bookmarks.json': { size: 9, mtime: 9 } } },
      { enumerateIncludedConfigPaths: async () => ['.obsidian/bookmarks.json'] },
    );
    expect((await scanner.scanLocalFiles()).get('.obsidian/bookmarks.json')).toEqual({ size: 9, mtime: 9 });
  });

  it('drops an included config path that no longer exists on disk', async () => {
    const { scanner } = build(FS, { enumerateIncludedConfigPaths: async () => ['.obsidian/gone.json'] });
    expect((await scanner.scanLocalFiles()).has('.obsidian/gone.json')).toBe(false);
  });

  it('honours system exclusion on both routes', async () => {
    const { scanner } = build(FS, { isSystemExcluded: (p) => p === 'notes/a.md' || p === '.env' });
    const found = await scanner.scanLocalFiles();
    expect(found.has('notes/a.md')).toBe(false);
    expect(found.has('.env')).toBe(false);
  });

  it('skips an excluded dot folder whole rather than descending into it', async () => {
    // This is why .git does not cost a full-tree walk on every scan.
    const { scanner, listCalls } = build(FS, { isSystemExcluded: (p) => p === '.archive' });
    const found = await scanner.scanLocalFiles();
    expect(listCalls).not.toContain('.archive');
    expect(found.has('.archive/old.md')).toBe(false);
  });

  it('survives an unreadable root instead of failing the whole scan', async () => {
    // A vault whose root cannot be listed still yields its Vault-tracked files.
    const { scanner } = build({ ...FS, dirs: {} });
    expect((await scanner.scanLocalFiles()).has('notes/a.md')).toBe(true);
  });

  it('survives an unreadable subdirectory, keeping what it already collected', async () => {
    const partial: FakeFs = { ...FS, dirs: { '': FS.dirs[''], '.archive': FS.dirs['.archive'] } };
    const found = await build(partial).scanner.scanLocalFiles();
    expect(found.get('.archive/old.md')).toEqual({ size: 3, mtime: 3 });
    expect(found.has('.archive/deep/older.md')).toBe(false);
  });
});

describe('LocalScanner.collectLocalStats', () => {
  it('fills the caller\'s map with the same two routes', async () => {
    const out = new Map<string, { size: number; mtime: number }>();
    await build(FS).scanner.collectLocalStats(out);
    expect(out.get('notes/a.md')).toEqual({ size: 10, mtime: 1 });
    expect(out.get('.env')).toEqual({ size: 2, mtime: 2 });
  });

  it('does NOT inject config paths — that is the caller\'s job on this route', async () => {
    const enumerateIncludedConfigPaths = jest.fn(async () => ['.obsidian/bookmarks.json']);
    const out = new Map<string, { size: number; mtime: number }>();
    await build(FS, { enumerateIncludedConfigPaths }).scanner.collectLocalStats(out);
    expect(enumerateIncludedConfigPaths).not.toHaveBeenCalled();
    expect(out.has('.obsidian/bookmarks.json')).toBe(false);
  });

  it('adds to what the map already holds rather than replacing it', async () => {
    const out = new Map([['seeded.md', { size: 1, mtime: 1 }]]);
    await build(FS).scanner.collectLocalStats(out);
    expect(out.has('seeded.md')).toBe(true);
    expect(out.has('notes/a.md')).toBe(true);
  });
});
