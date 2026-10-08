import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { TFile, Vault, DataAdapter } from 'obsidian';

// Vault-cache enumeration for local scan: scanLocalFiles / collectLocalStats read the normal (non-dot) file
// set from Vault.getFiles() (in-memory). adapter.list() is called once for root-level dot paths, never for
// recursive traversal of the regular vault tree.

type MockTFileCtor = new (path: string, stat?: { ctime?: number; mtime?: number; size?: number }) => TFile;
const MockTFile = TFile as unknown as MockTFileCtor;

const SETTINGS = {
  syncConfigFolder: false,
  configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
  networkConcurrency: 8,
};

function makeDataAdapter(): DataAdapter {
  return {
    read: jest.fn(),
    write: jest.fn(),
    readBinary: jest.fn(async () => new ArrayBuffer(0)),
    writeBinary: jest.fn(),
    exists: jest.fn(async () => false),
    remove: jest.fn(),
    rename: jest.fn(),
    mkdir: jest.fn(),
    stat: jest.fn(async () => null),
    list: jest.fn(async () => ({ files: [], folders: [] })),
  } as unknown as DataAdapter;
}

function makeVault(files: TFile[], adapter: DataAdapter): Vault {
  return {
    adapter,
    getAbstractFileByPath: jest.fn(() => null),
    getFiles: jest.fn(() => files),
    trash: jest.fn(),
  } as unknown as Vault;
}

function makeEngine(localAdapter: LocalAdapter) {
  const opts = {
    app: {},
    settings: SETTINGS,
    localAdapter,
    stateDB: {},
    statusBar: {},
    webdavFactory: {},
    pluginDir: '.obsidian/plugins/x',
    configDir: '.obsidian',
  };
  return new SyncEngine(opts as never);
}

describe('local-scan: Vault-cache enumeration (Task 2 / P0)', () => {
  it('collectLocalStats returns Vault-tracked files and does NOT call adapter.list for normal file traversal', async () => {
    const rawAdapter = makeDataAdapter();
    const vault = makeVault(
      [
        new MockTFile('a.md', { size: 10, mtime: 1000 }),
        new MockTFile('sub/b.md', { size: 20, mtime: 2000 }),
      ],
      rawAdapter,
    );
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);

    const out = new Map<string, { size: number; mtime: number }>();
    await (engine as unknown as {
      collectLocalStats(dir: string, out: Map<string, { size: number; mtime: number }>): Promise<void>;
    }).collectLocalStats('', out);

    expect(out.has('a.md')).toBe(true);
    expect(out.get('a.md')).toEqual({ size: 10, mtime: 1000 });
    expect(out.has('sub/b.md')).toBe(true);
    expect(out.get('sub/b.md')).toEqual({ size: 20, mtime: 2000 });

    // adapter.list is called once at the root to enumerate dot paths; the normal vault tree is served from the
    // Vault cache (no recursive list traversal).
    expect(rawAdapter.list).toHaveBeenCalledTimes(1);
    expect(rawAdapter.list).toHaveBeenCalledWith('');
  });

  it('scanLocalFiles returns Vault-tracked files with size+mtime and does NOT recurse adapter.list for normal files', async () => {
    const rawAdapter = makeDataAdapter();
    const vault = makeVault(
      [new MockTFile('note.md', { size: 5, mtime: 500 })],
      rawAdapter,
    );
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);

    // scanLocalFiles returns only size+mtime; no hash field.
    const result = await (engine as unknown as {
      scanLocalFiles(): Promise<Map<string, { size: number; mtime: number }>>;
    }).scanLocalFiles();

    expect(result.has('note.md')).toBe(true);
    const entry = result.get('note.md')!;
    expect(entry.size).toBe(5);
    expect(entry.mtime).toBe(500);
    // No readBinary should be called — hashing is deferred to buildInitialPlan.
    expect(rawAdapter.readBinary).not.toHaveBeenCalled();

    // adapter.list is called once at root for dot paths; note.md is served from the Vault cache.
    expect(rawAdapter.list).toHaveBeenCalledTimes(1);
    expect(rawAdapter.list).toHaveBeenCalledWith('');
  });

  it('excludes system-excluded paths (e.g. .obsidian/plugins/) from collectLocalStats', async () => {
    const rawAdapter = makeDataAdapter();
    const vault = makeVault(
      [
        new MockTFile('note.md', { size: 5, mtime: 1 }),
        new MockTFile('.obsidian/plugins/x/main.js', { size: 100, mtime: 1 }),
      ],
      rawAdapter,
    );
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);

    const out = new Map<string, { size: number; mtime: number }>();
    await (engine as unknown as {
      collectLocalStats(dir: string, out: Map<string, { size: number; mtime: number }>): Promise<void>;
    }).collectLocalStats('', out);

    expect(out.has('note.md')).toBe(true);
    expect(out.has('.obsidian/plugins/x/main.js')).toBe(false);
  });
});
