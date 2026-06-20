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

type PlanMap = Map<string, { hash: string; size: number; mtime: number }>;

describe('SyncEngine.buildInitialPlan — size-first (P0-C / FR-011)', () => {
  const engine = makeEngine({});
  const buildPlan = (local: PlanMap, remote: RemoteFileInfo[]) =>
    (engine as unknown as { buildInitialPlan(l: PlanMap, r: RemoteFileInfo[]): { uploads: string[]; downloads: string[]; conflicts: string[]; unchanged: string[] } })
      .buildInitialPlan(local, remote);

  const remote = (path: string, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo => ({
    path, fileId: 'f', checksum: null, etag: 'e', size: 100, lastModified: 1, ...over,
  });

  it('classifies a both-sides file with differing size as a conflict (no hash needed)', () => {
    const local: PlanMap = new Map([['a.md', { hash: 'AAA', size: 50, mtime: 1 }]]);
    const plan = buildPlan(local, [remote('a.md', { size: 100, checksum: 'AAA' })]);
    // Sizes differ → conflict, even though the (stale) checksum string happens to equal the local hash.
    expect(plan.conflicts).toContain('a.md');
    expect(plan.unchanged).not.toContain('a.md');
  });

  it('classifies same-size + matching server SHA-256 as unchanged', () => {
    const local: PlanMap = new Map([['a.md', { hash: 'HASH', size: 100, mtime: 1 }]]);
    const plan = buildPlan(local, [remote('a.md', { size: 100, checksum: 'HASH' })]);
    expect(plan.unchanged).toContain('a.md');
  });

  it('classifies same-size with no server checksum as a conflict (cannot prove unchanged)', () => {
    const local: PlanMap = new Map([['a.md', { hash: 'HASH', size: 100, mtime: 1 }]]);
    const plan = buildPlan(local, [remote('a.md', { size: 100, checksum: null })]);
    expect(plan.conflicts).toContain('a.md');
  });

  it('classifies same-size but size-gated (empty local hash) as a conflict', () => {
    const local: PlanMap = new Map([['big.bin', { hash: '', size: 100, mtime: 1 }]]);
    const plan = buildPlan(local, [remote('big.bin', { size: 100, checksum: 'SOMETHING' })]);
    expect(plan.conflicts).toContain('big.bin');
  });

  it('uploads a local-only file and downloads a remote-only file', () => {
    const local: PlanMap = new Map([['localonly.md', { hash: 'H', size: 10, mtime: 1 }]]);
    const plan = buildPlan(local, [remote('remoteonly.md')]);
    expect(plan.uploads).toContain('localonly.md');
    expect(plan.downloads).toContain('remoteonly.md');
  });
});

describe('SyncEngine.scanLocalFiles — size-gate (P0-C / FR-012)', () => {
  it('does not pre-hash files larger than MAX_HASH_SIZE', async () => {
    // Migrate to Vault-mock approach (Task 2: scanLocalFiles now reads from listVaultFiles()).
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
    const scan = await (engine as unknown as { scanLocalFiles(): Promise<Map<string, { hash: string; size: number; mtime: number }>> }).scanLocalFiles();
    expect(scan.get('small.md')?.hash).not.toBe('');
    expect(scan.get('big.bin')?.hash).toBe(''); // deferred
    // readBinary called for the small file only, not the large one.
    expect(readBinary).toHaveBeenCalledTimes(1);
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

    const localFiles = new Map([['a.md', { hash: 'H', size: 0, mtime: 1 }]]);
    await (engine as unknown as {
      executePlan(p: unknown, r: unknown[], s: unknown, l: unknown): Promise<void>;
    }).executePlan(
      { uploads: ['a.md'], downloads: [], conflicts: [], unchanged: [], deletes: [] },
      [], { uploadedCount: 0 }, localFiles,
    );
    expect(scanSpy).not.toHaveBeenCalled();
  });
});
