import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { TFile, Vault, DataAdapter } from 'obsidian';

/**
 * Task 7: Restore syncing of non-config dot paths (fix final-review C1).
 *
 * Vault.getFiles() excludes ALL dot-prefixed paths. The previous adapter.list() scan synced
 * non-.obsidian dot files/folders (e.g. .archive/, root .env). This test suite verifies that
 * collectDotPaths() re-enumerates those paths and both scan entry points include them.
 */

type MockTFileCtor = new (path: string, stat?: { ctime?: number; mtime?: number; size?: number }) => TFile;
const MockTFile = TFile as unknown as MockTFileCtor;

const SETTINGS = {
  syncConfigFolder: false,
  configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
  networkConcurrency: 8,
};

/**
 * Build a DataAdapter mock where adapter.list('') returns:
 *   files: ['.env']
 *   folders: ['.archive', '.obsidian']
 *
 * And adapter.list('.archive') returns:
 *   files: ['.archive/note.md']
 *   folders: []
 *
 * adapter.stat() returns a minimal stat for known paths.
 */
function makeDataAdapterWithDotPaths(): DataAdapter {
  const statMap: Record<string, { size: number; mtime: number }> = {
    '.env': { size: 42, mtime: 1001 },
    '.archive/note.md': { size: 100, mtime: 2002 },
    '.git/config': { size: 7, mtime: 3003 },
    '.trash/deleted.md': { size: 9, mtime: 4004 },
  };

  const listMap: Record<string, { files: string[]; folders: string[] }> = {
    '': { files: ['.env'], folders: ['.archive', '.obsidian', '.git', '.trash'] },
    '.archive': { files: ['.archive/note.md'], folders: [] },
    '.obsidian': { files: ['.obsidian/appearance.json'], folders: [] },
    '.git': { files: ['.git/config'], folders: [] },
    '.trash': { files: ['.trash/deleted.md'], folders: [] },
  };

  return {
    read: jest.fn(),
    write: jest.fn(),
    readBinary: jest.fn(async () => new ArrayBuffer(0)),
    writeBinary: jest.fn(),
    exists: jest.fn(async () => false),
    remove: jest.fn(),
    rename: jest.fn(),
    mkdir: jest.fn(),
    stat: jest.fn(async (path: string) => statMap[path] ?? null),
    list: jest.fn(async (path: string) => listMap[path] ?? { files: [], folders: [] }),
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

// Vault returns only normal (non-dot) files; dot paths come exclusively from adapter.
const VAULT_FILES = [
  new MockTFile('note.md', { size: 5, mtime: 500 }),
  new MockTFile('sub/doc.md', { size: 10, mtime: 1000 }),
];

describe('dot-paths: collectDotPaths supplements Vault-enumerated files (Task 7)', () => {
  it('scanLocalFiles includes .env and .archive/note.md from adapter', async () => {
    const rawAdapter = makeDataAdapterWithDotPaths();
    const vault = makeVault(VAULT_FILES, rawAdapter);
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);

    const result = await (engine as unknown as {
      scanLocalFiles(): Promise<Map<string, { size: number; mtime: number }>>;
    }).scanLocalFiles();

    // Dot paths from adapter must appear.
    expect(result.has('.env')).toBe(true);
    expect(result.get('.env')).toEqual({ size: 42, mtime: 1001 });
    expect(result.has('.archive/note.md')).toBe(true);
    expect(result.get('.archive/note.md')).toEqual({ size: 100, mtime: 2002 });
  });

  it('[SPEC:EXCL-HARD-1] scanLocalFiles does NOT include hard-excluded .git/.trash (collectDotPaths skips them)', async () => {
    const rawAdapter = makeDataAdapterWithDotPaths();
    const vault = makeVault(VAULT_FILES, rawAdapter);
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);

    const result = await (engine as unknown as {
      scanLocalFiles(): Promise<Map<string, { size: number; mtime: number }>>;
    }).scanLocalFiles();

    // .git and .trash are re-enumerated at the vault root by collectDotPaths, but isSystemExcluded
    // filters them out — the whole tree is skipped, so no file under them is synced.
    expect(result.has('.git/config')).toBe(false);
    expect(result.has('.trash/deleted.md')).toBe(false);
    // Regression: non-machine root dot content is still present.
    expect(result.has('.env')).toBe(true);
    expect(result.has('.archive/note.md')).toBe(true);
  });

  it('scanLocalFiles still includes normal Vault-tracked files', async () => {
    const rawAdapter = makeDataAdapterWithDotPaths();
    const vault = makeVault(VAULT_FILES, rawAdapter);
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);

    const result = await (engine as unknown as {
      scanLocalFiles(): Promise<Map<string, { size: number; mtime: number }>>;
    }).scanLocalFiles();

    expect(result.has('note.md')).toBe(true);
    expect(result.has('sub/doc.md')).toBe(true);
  });

  it('scanLocalFiles does NOT include .obsidian paths via collectDotPaths (config dir handled separately)', async () => {
    const rawAdapter = makeDataAdapterWithDotPaths();
    const vault = makeVault(VAULT_FILES, rawAdapter);
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);

    const result = await (engine as unknown as {
      scanLocalFiles(): Promise<Map<string, { size: number; mtime: number }>>;
    }).scanLocalFiles();

    // .obsidian/appearance.json must NOT appear via collectDotPaths because ConfigSyncResolver
    // handles config folder separately (and syncConfigFolder=false here, so nothing from it).
    expect(result.has('.obsidian/appearance.json')).toBe(false);
  });

  it('collectLocalStats includes .env and .archive/note.md from adapter', async () => {
    const rawAdapter = makeDataAdapterWithDotPaths();
    const vault = makeVault(VAULT_FILES, rawAdapter);
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);

    const out = new Map<string, { size: number; mtime: number }>();
    await (engine as unknown as {
      collectLocalStats(dir: string, out: Map<string, { size: number; mtime: number }>): Promise<void>;
    }).collectLocalStats('', out);

    // Dot paths from adapter must appear.
    expect(out.has('.env')).toBe(true);
    expect(out.get('.env')).toEqual({ size: 42, mtime: 1001 });
    expect(out.has('.archive/note.md')).toBe(true);
    expect(out.get('.archive/note.md')).toEqual({ size: 100, mtime: 2002 });
  });

  it('collectLocalStats still includes normal Vault-tracked files', async () => {
    const rawAdapter = makeDataAdapterWithDotPaths();
    const vault = makeVault(VAULT_FILES, rawAdapter);
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);

    const out = new Map<string, { size: number; mtime: number }>();
    await (engine as unknown as {
      collectLocalStats(dir: string, out: Map<string, { size: number; mtime: number }>): Promise<void>;
    }).collectLocalStats('', out);

    expect(out.has('note.md')).toBe(true);
    expect(out.has('sub/doc.md')).toBe(true);
  });

  it('collectLocalStats does NOT include .obsidian paths via collectDotPaths', async () => {
    const rawAdapter = makeDataAdapterWithDotPaths();
    const vault = makeVault(VAULT_FILES, rawAdapter);
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);

    const out = new Map<string, { size: number; mtime: number }>();
    await (engine as unknown as {
      collectLocalStats(dir: string, out: Map<string, { size: number; mtime: number }>): Promise<void>;
    }).collectLocalStats('', out);

    expect(out.has('.obsidian/appearance.json')).toBe(false);
  });
});
