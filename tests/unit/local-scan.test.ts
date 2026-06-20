import { LocalAdapter } from '../../src/data/LocalAdapter';
import { SyncEngine } from '../../src/sync/SyncEngine';
import { TFile, Vault, DataAdapter } from 'obsidian';

/**
 * Task 2: Vault-cache enumeration for local scan (P0).
 *
 * Verifies that scanLocalFiles / collectLocalStats read from Vault.getFiles() (synchronous,
 * in-memory) rather than calling adapter.list() (async native bridge, expensive on mobile).
 */

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
  it('collectLocalStats returns Vault-tracked files and does NOT call adapter.list', async () => {
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

    // Both vault files must appear in the result.
    expect(out.has('a.md')).toBe(true);
    expect(out.get('a.md')).toEqual({ size: 10, mtime: 1000 });
    expect(out.has('sub/b.md')).toBe(true);
    expect(out.get('sub/b.md')).toEqual({ size: 20, mtime: 2000 });

    // Native adapter.list must NEVER be called (that is the whole point of this optimization).
    expect(rawAdapter.list).not.toHaveBeenCalled();
  });

  it('scanLocalFiles returns Vault-tracked files and does NOT call adapter.list', async () => {
    const rawAdapter = makeDataAdapter();
    const vault = makeVault(
      [new MockTFile('note.md', { size: 5, mtime: 500 })],
      rawAdapter,
    );
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);

    const result = await (engine as unknown as {
      scanLocalFiles(): Promise<Map<string, { hash: string; size: number; mtime: number }>>;
    }).scanLocalFiles();

    expect(result.has('note.md')).toBe(true);
    const entry = result.get('note.md')!;
    expect(entry.size).toBe(5);
    expect(entry.mtime).toBe(500);
    // Hash must be a non-empty string (file is small, below MAX_HASH_SIZE).
    expect(entry.hash).not.toBe('');

    // adapter.list must NOT be invoked.
    expect(rawAdapter.list).not.toHaveBeenCalled();
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
    // Plugin files are system-excluded.
    expect(out.has('.obsidian/plugins/x/main.js')).toBe(false);
  });
});
