// Feature 087 (issue #51): proves the engine needs NO changes to do the right thing with an
// unreadable listing — the fix lives entirely in the WebDAV client layer (readMultistatus), and this
// file exists to show that a RemoteListingUnreadableError thrown from a client double already lands
// on the SAME catch blocks that a network outage does: the session is recorded as failed, nothing is
// deleted, nothing is uploaded, and StateDB is untouched. Modelled on
// tests/a-no-nextcloud/sync/emptyListingAbsenceDelete.test.ts (real SyncEngine + real StateDB; only
// the WebDAV client, LocalAdapter and Obsidian App are doubles) because re-implementing the
// classification in a mock would prove nothing about the actual catch wiring.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import {
  DEFAULT_SETTINGS, DirState, FileState, RemoteFileInfo, RemoteDirInfo, SyncSessionSummary,
} from '../../../src/types';
import { RemoteListingUnreadableError } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';
import { TFile, TFolder } from '../support/obsidian';

const enc = new TextEncoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
const BASE_MTIME = 1_000;

const unreadable = (op: string, path = ''): RemoteListingUnreadableError =>
  new RemoteListingUnreadableError({ op, path, status: 207, method: 'PROPFIND' }, '<html>502</html>', 'root is html, not DAV:multistatus');

function makeStateAdapter(): DataAdapter {
  const store: Record<string, string> = {};
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (f: string, t: string) => { store[t] = store[f]; delete store[f]; }),
    stat: jest.fn(), list: jest.fn(), readBinary: jest.fn(), writeBinary: jest.fn(),
  } as unknown as DataAdapter;
}

function makeLocalAdapter(files: Record<string, string>) {
  const sizeOf = (p: string): number => enc.encode(files[p]).length;
  return {
    files,
    listVaultFiles: jest.fn(() =>
      Object.keys(files).map((p) => ({ path: p, size: sizeOf(p), mtime: BASE_MTIME }))),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async (p: string) => (p in files ? { size: sizeOf(p), mtime: BASE_MTIME } : null)),
    exists: jest.fn(async (p: string) => p in files),
    read: jest.fn(async (p: string) => files[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(files[p] ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = new TextDecoder().decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = new TextDecoder().decode(d); }),
    setMtime: jest.fn(),
    ignore: jest.fn(),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
  };
}

interface RemoteWorld {
  listing: RemoteFileInfo[] | (() => RemoteFileInfo[] | never);
  directories?: RemoteDirInfo[] | (() => RemoteDirInfo[] | never);
  rootEtag: string | null;
  statFile?: () => Promise<RemoteFileInfo | null>;
}

async function buildEngine(
  vault: Record<string, string>, world: RemoteWorld, localFolders: string[] = [],
) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const localAdapter = makeLocalAdapter(vault);

  const client = {
    getRootEtag: jest.fn(async () => world.rootEtag),
    getFiles: jest.fn(async () => {
      if (typeof world.listing === 'function') return world.listing();
      return world.listing;
    }),
    getSyncToken: jest.fn(async (): Promise<string | null> => null),
    remoteExists: jest.fn(async () => false),
    statFile: jest.fn(world.statFile ?? (async (): Promise<RemoteFileInfo | null> => null)),
    uploadFile: jest.fn(async () => undefined),
    deleteFile: jest.fn(async () => undefined),
    getDirectories: jest.fn(async () => {
      if (!world.directories) return [];
      if (typeof world.directories === 'function') return world.directories();
      return world.directories;
    }),
    createDirectory: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async () => undefined),
    isRemoteDirEmpty: jest.fn(async () => true),
    recalcChecksum: jest.fn(async (): Promise<string | null> => null),
    downloadFile: jest.fn(async () => toBuf('downloaded')),
  };
  const createClient = jest.fn(async () => ({ client, features: { isNextcloud: true } }));

  const trashed: string[] = [];
  const localFolderSet = new Set(localFolders);
  const app = {
    vault: {
      adapter: {
        exists: jest.fn(async (p: string) => p in vault),
        remove: jest.fn(async (p: string) => { delete vault[p]; }),
        mkdir: jest.fn(async (p: string) => { localFolderSet.add(p); }),
      },
      getAbstractFileByPath: (p: string) => {
        if (p in vault) return new TFile(p);
        if (localFolderSet.has(p)) return new TFolder(p);
        return null;
      },
      getAllFolders: () => [...localFolderSet].map((p) => new TFolder(p)),
    },
    fileManager: {
      trashFile: jest.fn(async (f: TFile | TFolder) => { trashed.push(f.path); delete vault[f.path]; localFolderSet.delete(f.path); }),
    },
  };

  const logs: string[] = [];
  const logger = { log: jest.fn(async (m: string) => { logs.push(m); }) };
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };

  const engine = new SyncEngine({
    app, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
    localAdapter, stateDB, statusBar, webdavFactory: { createClient }, logger,
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  const sync = async (): Promise<SyncSessionSummary> => {
    await engine.syncManual({ manual: true });
    await stateDB.flush();
    return engine.getLastSessionSummary()!;
  };

  return { engine, stateDB, localAdapter, client, app, trashed, logs, sync, vault };
}

async function track(stateDB: StateDB, path: string, body: string): Promise<FileState> {
  const hash = await sha256(toBuf(body));
  const size = enc.encode(body).length;
  const fs: FileState = {
    path, localHash: hash, remoteId: hash, idType: 'sha256',
    size, mtime: BASE_MTIME, remoteFileId: `fid-${path}`, isConflicted: false,
    localMtime: BASE_MTIME, localSize: size, remoteMtime: BASE_MTIME,
  };
  stateDB.setFile(fs);
  return fs;
}

function trackDir(stateDB: StateDB, path: string): DirState {
  const d: DirState = { path, remoteFileId: `fid-${path}` };
  stateDB.setDir(d);
  return d;
}

beforeEach(() => {
  (globalThis as { navigator?: unknown }).navigator ??= {};
});

describe('ULG-13 an unreadable getFiles listing fails the session instead of deleting anything', () => {
  it.each([
    ['above the mass-delete breaker threshold', 30],
    ['below the mass-delete breaker threshold', 3],
  ])('US1-1/1-2: with %s tracked files, nothing is deleted and StateDB is untouched', async (_label, n) => {
    const vault: Record<string, string> = {};
    for (let i = 0; i < n; i++) vault[`note${i}.md`] = `body ${i}`;
    const h = await buildEngine(vault, { listing: () => { throw unreadable('getFiles'); }, rootEtag: null });
    const before: FileState[] = [];
    for (const [p, body] of Object.entries(vault)) before.push(await track(h.stateDB, p, body));

    const summary = await h.sync();

    expect(h.client.deleteFile).not.toHaveBeenCalled();
    expect(h.trashed).toEqual([]);
    expect(h.client.remoteExists).not.toHaveBeenCalled();
    expect(h.stateDB.getAllFiles()).toEqual(expect.arrayContaining(before));
    expect(h.stateDB.getAllFiles()).toHaveLength(before.length);
    expect(summary.errorCount).toBe(1);
    expect(summary.errors[0].message).toContain('Remote listing unreadable');
    expect(summary.errors.find((e) => e.path === '(mass-delete breaker)')).toBeUndefined();
  });
});

describe('ULG-14 self-healing: a failed session does not stop the vault from converging', () => {
  it('US1-7: the following sync with a readable listing deletes nothing extra and leaves tracking intact', async () => {
    const vault = { 'a.md': 'alpha' };
    let broken = true;
    const h = await buildEngine(vault, {
      listing: () => { if (broken) throw unreadable('getFiles'); return [{ path: 'a.md', fileId: 'f', checksum: null, etag: '"e"', size: 5, lastModified: 0 }]; },
      rootEtag: null,
    });
    await track(h.stateDB, 'a.md', 'alpha');

    const failed = await h.sync();
    expect(failed.errorCount).toBe(1);

    broken = false;
    const recovered = await h.sync();
    expect(recovered.errorCount).toBe(0);
    expect(recovered.deletedCount).toBe(0);
    expect(h.client.deleteFile).not.toHaveBeenCalled();
    expect(h.stateDB.getFile('a.md')).toBeDefined();
  });

  it('US1-8: a failed session does not arm the root-ETag short-circuit for the next sync', async () => {
    const vault = { 'a.md': 'alpha' };
    const h = await buildEngine(vault, { listing: () => { throw unreadable('getFiles'); }, rootEtag: 'stable-etag' });
    await track(h.stateDB, 'a.md', 'alpha');

    await h.sync();
    h.client.getFiles.mockClear();
    await h.sync();

    // A short-circuited sync never calls getFiles at all (it rebuilds from State). Calling it here
    // proves the failed session did not leave the engine willing to trust a stale short-circuit.
    expect(h.client.getFiles).toHaveBeenCalled();
  });
});

describe('ULG-15 an unreadable getDirectories listing skips directory reconciliation only', () => {
  it('US2-1: no folder is trashed or deleted, dir tracking is untouched, and the skip is logged', async () => {
    const vault = { 'F/a.md': 'alpha' };
    const h = await buildEngine(vault, {
      listing: () => [{ path: 'F/a.md', fileId: 'f', checksum: null, etag: '"e"', size: 5, lastModified: 0 }],
      directories: () => { throw unreadable('getDirectories'); },
      rootEtag: null,
    }, ['F']);
    await track(h.stateDB, 'F/a.md', 'alpha');
    const dirBefore = trackDir(h.stateDB, 'F');

    const summary = await h.sync();

    expect(h.trashed).toEqual([]);
    expect(h.client.deleteCollection).not.toHaveBeenCalled();
    expect(h.stateDB.getDir('F')).toEqual(dirBefore);
    expect(h.logs.join('\n')).toContain('dir-sync: listing failed — skip this session');
    // The file side still converges independently — only directory reconciliation is skipped.
    expect(summary.errorCount).toBe(0);
  });
});

describe('ULG-16 an unreadable statFile probe keeps tracking instead of deleting', () => {
  it('US2-2: a file absent locally and from the listing is neither deleted nor forgotten', async () => {
    const h = await buildEngine({}, {
      listing: [],
      rootEtag: null,
      statFile: async () => { throw unreadable('statFile', 'gone.md'); },
    });
    const before = await track(h.stateDB, 'gone.md', 'was here');

    const summary = await h.sync();

    expect(h.client.deleteFile).not.toHaveBeenCalled();
    expect(h.stateDB.getFile('gone.md')).toEqual(before);
    expect(summary.errorCount).toBe(1);
    expect(summary.errors[0].message).toContain('Remote listing unreadable');
  });
});

describe('ULG-17 an unreadable listing on the very first sync uploads nothing', () => {
  it('leaves State empty rather than treating local files as new uploads', async () => {
    const h = await buildEngine({ 'a.md': 'alpha' }, { listing: () => { throw unreadable('getFiles'); }, rootEtag: null });
    // No track() call: StateDB starts empty, which is what routes syncManual to the initial-sync path.

    const summary = await h.sync();

    expect(h.client.uploadFile).not.toHaveBeenCalled();
    expect(h.stateDB.getAllFiles()).toEqual([]);
    expect(summary.errorCount).toBe(1);
  });
});

describe('US3-1/US3-2 the diagnostic reaches the log exactly once, in the shape a maintainer can read', () => {
  it('logs one "sync: FAILED" line carrying the call, path, byte count and reason', async () => {
    const h = await buildEngine({ 'a.md': 'alpha' }, { listing: () => { throw unreadable('getFiles'); }, rootEtag: null });
    await track(h.stateDB, 'a.md', 'alpha');

    const summary = await h.sync();

    const failedLines = h.logs.filter((l) => l.startsWith('sync: FAILED — Remote listing unreadable:'));
    expect(failedLines).toHaveLength(1);
    expect(failedLines[0]).toContain("getFiles ''");
    expect(failedLines[0]).toContain('bytes');
    expect(failedLines[0]).not.toContain('\n');
    expect(summary.errors[0].message).toBe(failedLines[0].replace('sync: FAILED — ', ''));
  });
});
