import { SyncEngine } from '../../src/sync/SyncEngine';
import { LocalAdapter } from '../../src/data/LocalAdapter';
import { RemoteFileInfo } from '../../src/types';
import { MAX_HASH_SIZE } from '../../src/util/limits';
import { TFile, Vault, DataAdapter } from 'obsidian';

// Cast TFile to allow construction in tests (same pattern as LocalAdapter.test.ts).
type MockTFileCtor = new (path: string, stat?: { ctime?: number; mtime?: number; size?: number }) => TFile;
const MockTFile = TFile as unknown as MockTFileCtor;

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

/**
 * P0-C first-sync optimizations: no double whole-vault hash (executePlan reuses the scan), size-first
 * plan classification, and a size-gate that defers hashing of large files during the scan.
 */

const SETTINGS = {
  // Config-folder sync OFF so enumerateIncludedPaths() returns [] (keeps the scan to the vault tree).
  syncConfigFolder: false,
  configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
  networkConcurrency: 8,
};

function makeEngine(localAdapter: unknown) {
  const opts = {
    app: {}, settings: SETTINGS, localAdapter,
    stateDB: {}, statusBar: {}, webdavFactory: {},
    pluginDir: '.obsidian/plugins/x', configDir: '.obsidian',
  };
  return new SyncEngine(opts as never);
}

/** LocalFiles type after Task 3: no hash field. */
type LocalFiles = Map<string, { size: number; mtime: number }>;

// --- Task 3: size-first hashing — buildInitialPlan is now async and hashes lazily ---

describe('SyncEngine.buildInitialPlan — size-first lazy hash (Task 3)', () => {
  const remote = (path: string, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo => ({
    path, fileId: 'f', checksum: null, etag: 'e', size: 100, lastModified: 1, ...over,
  });

  /** Known SHA-256 of an all-zero 4-byte buffer (computed independently). */
  const ZERO4_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('size-first: local-only file → uploads, readBinary NOT called', async () => {
    const readBinary = jest.fn(async () => new ArrayBuffer(0));
    const localAdapter = { readBinary };
    const engine = makeEngine(localAdapter);
    const localFiles: LocalFiles = new Map([['local.md', { size: 10, mtime: 1 }]]);
    const plan = await (engine as unknown as {
      buildInitialPlan(l: LocalFiles, r: RemoteFileInfo[]): Promise<{ uploads: string[]; downloads: string[]; conflicts: string[]; unchanged: string[] }>;
    }).buildInitialPlan(localFiles, []);
    expect(plan.uploads).toContain('local.md');
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('size-first: size mismatch → conflicts, readBinary NOT called', async () => {
    const readBinary = jest.fn(async () => new ArrayBuffer(0));
    const localAdapter = { readBinary };
    const engine = makeEngine(localAdapter);
    const localFiles: LocalFiles = new Map([['a.md', { size: 50, mtime: 1 }]]);
    const plan = await (engine as unknown as {
      buildInitialPlan(l: LocalFiles, r: RemoteFileInfo[]): Promise<{ uploads: string[]; downloads: string[]; conflicts: string[]; unchanged: string[] }>;
    }).buildInitialPlan(localFiles, [remote('a.md', { size: 100, checksum: 'SOMESUM' })]);
    expect(plan.conflicts).toContain('a.md');
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('size-first: size match + matching server checksum → unchanged, readBinary called for ONLY this file', async () => {
    // readBinary returns 4 zero bytes — sha256('') is the known constant above.
    // Actually, sha256 of an empty ArrayBuffer is the constant; use that.
    const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const readBinary = jest.fn(async () => new ArrayBuffer(0));
    const localAdapter = { readBinary };
    const engine = makeEngine(localAdapter);
    // Three files: one upload (no remote), one size-mismatch (conflict), one match (unchanged).
    const localFiles: LocalFiles = new Map([
      ['upload.md', { size: 10, mtime: 1 }],
      ['conflict.md', { size: 50, mtime: 1 }],
      ['match.md', { size: 0, mtime: 1 }],
    ]);
    const plan = await (engine as unknown as {
      buildInitialPlan(l: LocalFiles, r: RemoteFileInfo[]): Promise<{ uploads: string[]; downloads: string[]; conflicts: string[]; unchanged: string[] }>;
    }).buildInitialPlan(localFiles, [
      remote('conflict.md', { size: 100, checksum: emptyHash }),
      remote('match.md', { size: 0, checksum: emptyHash }),
    ]);
    expect(plan.uploads).toContain('upload.md');
    expect(plan.conflicts).toContain('conflict.md');
    expect(plan.unchanged).toContain('match.md');
    // readBinary should be called ONLY for match.md (the only file needing a hash proof).
    expect(readBinary).toHaveBeenCalledTimes(1);
    expect(readBinary).toHaveBeenCalledWith('match.md');
  });

  it('size-first: size match but no server checksum → conflict, readBinary NOT called', async () => {
    const readBinary = jest.fn(async () => new ArrayBuffer(0));
    const localAdapter = { readBinary };
    const engine = makeEngine(localAdapter);
    const localFiles: LocalFiles = new Map([['a.md', { size: 100, mtime: 1 }]]);
    const plan = await (engine as unknown as {
      buildInitialPlan(l: LocalFiles, r: RemoteFileInfo[]): Promise<{ uploads: string[]; downloads: string[]; conflicts: string[]; unchanged: string[] }>;
    }).buildInitialPlan(localFiles, [remote('a.md', { size: 100, checksum: null })]);
    expect(plan.conflicts).toContain('a.md');
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('size-first: size match but file exceeds MAX_HASH_SIZE → conflict, readBinary NOT called', async () => {
    const readBinary = jest.fn(async () => new ArrayBuffer(0));
    const localAdapter = { readBinary };
    const engine = makeEngine(localAdapter);
    const bigSize = MAX_HASH_SIZE + 1;
    const localFiles: LocalFiles = new Map([['big.bin', { size: bigSize, mtime: 1 }]]);
    const plan = await (engine as unknown as {
      buildInitialPlan(l: LocalFiles, r: RemoteFileInfo[]): Promise<{ uploads: string[]; downloads: string[]; conflicts: string[]; unchanged: string[] }>;
    }).buildInitialPlan(localFiles, [remote('big.bin', { size: bigSize, checksum: 'SOMESUM' })]);
    expect(plan.conflicts).toContain('big.bin');
    expect(readBinary).not.toHaveBeenCalled();
  });
});

// --- Legacy tests updated for Task 3 type (no hash in LocalFiles) ---

describe('SyncEngine.buildInitialPlan — size-first (P0-C / FR-011)', () => {
  const engine = makeEngine({
    readBinary: jest.fn(async () => new ArrayBuffer(0)),
  });
  const buildPlan = (local: LocalFiles, remote: RemoteFileInfo[]) =>
    (engine as unknown as { buildInitialPlan(l: LocalFiles, r: RemoteFileInfo[]): Promise<{ uploads: string[]; downloads: string[]; conflicts: string[]; unchanged: string[] }> })
      .buildInitialPlan(local, remote);

  const remote = (path: string, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo => ({
    path, fileId: 'f', checksum: null, etag: 'e', size: 100, lastModified: 1, ...over,
  });

  it('classifies a both-sides file with differing size as a conflict (no hash needed)', async () => {
    const local: LocalFiles = new Map([['a.md', { size: 50, mtime: 1 }]]);
    const plan = await buildPlan(local, [remote('a.md', { size: 100, checksum: 'AAA' })]);
    // Sizes differ → conflict.
    expect(plan.conflicts).toContain('a.md');
    expect(plan.unchanged).not.toContain('a.md');
  });

  it('classifies same-size with no server checksum as a conflict (cannot prove unchanged)', async () => {
    const local: LocalFiles = new Map([['a.md', { size: 100, mtime: 1 }]]);
    const plan = await buildPlan(local, [remote('a.md', { size: 100, checksum: null })]);
    expect(plan.conflicts).toContain('a.md');
  });

  it('uploads a local-only file and downloads a remote-only file', async () => {
    const local: LocalFiles = new Map([['localonly.md', { size: 10, mtime: 1 }]]);
    const plan = await buildPlan(local, [remote('remoteonly.md')]);
    expect(plan.uploads).toContain('localonly.md');
    expect(plan.downloads).toContain('remoteonly.md');
  });
});

describe('SyncEngine.scanLocalFiles — no pre-hashing (Task 3 / FR-012)', () => {
  it('returns only size+mtime; readBinary is never called during the scan', async () => {
    // Task 3: scanLocalFiles no longer hashes files at all.
    const readBinary = jest.fn(async () => new ArrayBuffer(1));
    const rawAdapter = makeDataAdapter();
    (rawAdapter.readBinary as jest.Mock).mockImplementation(readBinary);
    const vault = makeVault(
      [
        new MockTFile('small.md', { size: 4, mtime: 1 }),
        new MockTFile('big.bin', { size: MAX_HASH_SIZE + 1, mtime: 1 }),
      ],
      rawAdapter,
    );
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = makeEngine(localAdapter);
    const scan = await (engine as unknown as { scanLocalFiles(): Promise<Map<string, { size: number; mtime: number }>> }).scanLocalFiles();
    // Both files must be present with correct stats.
    expect(scan.get('small.md')).toEqual({ size: 4, mtime: 1 });
    expect(scan.get('big.bin')).toEqual({ size: MAX_HASH_SIZE + 1, mtime: 1 });
    // readBinary must NOT be called at all during the scan.
    expect(readBinary).not.toHaveBeenCalled();
  });
});

describe('SyncEngine.executePlan — reuses the scan (P0-C / FR-010, no double hash)', () => {
  it('does not call scanLocalFiles again when given the localFiles map', async () => {
    const localAdapter = {
      readBinary: jest.fn(async () => new ArrayBuffer(0)),
      stat: jest.fn(async () => ({ size: 0, mtime: 1 })),
      setMtime: jest.fn(async () => undefined),
    };
    const engine = makeEngine(localAdapter);
    const scanSpy = jest.spyOn(engine as unknown as { scanLocalFiles: () => Promise<unknown> }, 'scanLocalFiles');
    (engine as unknown as { client: unknown }).client = {};
    (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = { upload: jest.fn(async () => 'skipped') };
    (engine as unknown as { opts: { stateDB: unknown } }).opts.stateDB = { setFile: jest.fn() };
    (engine as unknown as { opts: { statusBar: unknown } }).opts.statusBar = { setProgress: jest.fn() };

    const localFiles: LocalFiles = new Map([['a.md', { size: 0, mtime: 1 }]]);
    await (engine as unknown as {
      executePlan(p: unknown, r: unknown[], s: unknown, l: unknown): Promise<void>;
    }).executePlan(
      { uploads: ['a.md'], downloads: [], conflicts: [], unchanged: [], deletes: [] },
      [], { uploadedCount: 0 }, localFiles,
    );
    expect(scanSpy).not.toHaveBeenCalled();
  });
});
