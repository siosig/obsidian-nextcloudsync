// The mass-delete breaker in the UP direction: too many tracked files missing locally at once must not be
// propagated to the server as DELETEs.
//
// The down-direction breaker (massDeletion.test.ts) protects a device from a server listing that makes most of
// the vault look gone. The mirror image is a device whose vault suddenly looks empty (an accidental bulk delete,
// a script, another sync tool, a vault folder that failed to mount): every tracked file it lost reads as "the
// user deleted it" and, without a cap, every one of them is deleted on the server and then on every other
// device. The same limit (massDeleteLimit) now caps both directions. (docs/spec.md §8)
//
// These tests drive the REAL SyncEngine over a real StateDB (in-memory DataAdapter); only the WebDAV client,
// the LocalAdapter and Obsidian's App are doubles.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';
import { TFile, TFolder } from '../support/obsidian';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
const BASE_MTIME = 1_000;
const BREAKER = '(outbound mass-delete breaker)';

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

// A listing entry whose checksum matches what {@link track} recorded: the server copy is unchanged.
async function listed(path: string, body: string): Promise<RemoteFileInfo> {
  return {
    path, fileId: `fid-${path}`, checksum: await sha256(toBuf(body)), etag: null,
    size: enc.encode(body).length, lastModified: BASE_MTIME,
  };
}

async function track(stateDB: StateDB, path: string, body: string): Promise<void> {
  const hash = await sha256(toBuf(body));
  const size = enc.encode(body).length;
  const fs: FileState = {
    path, localHash: hash, remoteId: hash, idType: 'sha256',
    size, mtime: BASE_MTIME, remoteFileId: `fid-${path}`, isConflicted: false,
    localMtime: BASE_MTIME, localSize: size, remoteMtime: BASE_MTIME,
  };
  stateDB.setFile(fs);
}

// `total` files synced on both sides; the first `deleted` of them are then removed from the local vault only.
async function setup(total: number, deleted: number, settings: Partial<typeof DEFAULT_SETTINGS> = {}, dir = '') {
  const names = Array.from({ length: total }, (_, i) => `${dir ? `${dir}/` : ''}note${i}.md`);
  const body = (p: string): string => `body of ${p}`;
  const vault: Record<string, string> = {};
  for (const p of names.slice(deleted)) vault[p] = body(p);
  const listing = await Promise.all(names.map(p => listed(p, body(p))));
  const bodies = Object.fromEntries(names.map(p => [p, body(p)]));

  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  for (const p of names) await track(stateDB, p, body(p));
  if (dir) stateDB.setDir({ path: dir, remoteFileId: `dir-${dir}` });

  const sizeOf = (p: string): number => enc.encode(vault[p]).length;
  const localAdapter = {
    files: vault,
    listVaultFiles: jest.fn(() =>
      Object.keys(vault).map(p => ({ path: p, size: sizeOf(p), mtime: BASE_MTIME }))),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async (p: string) => (p in vault ? { size: sizeOf(p), mtime: BASE_MTIME } : null)),
    exists: jest.fn(async (p: string) => p in vault),
    read: jest.fn(async (p: string) => vault[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(vault[p] ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { vault[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { vault[p] = dec.decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { vault[p] = dec.decode(d); }),
    remove: jest.fn(async (p: string) => { delete vault[p]; }),
    ignore: jest.fn(),
  };

  const client = {
    getRootEtag: jest.fn(async (): Promise<string | null> => null),
    getFiles: jest.fn(async () => listing),
    getDirectories: jest.fn(async () => []),
    getSyncToken: jest.fn(async (): Promise<string | null> => null),
    remoteExists: jest.fn(async () => true),
    statFile: jest.fn(async (p: string) => listing.find(f => f.path === p) ?? null),
    uploadFile: jest.fn(async () => undefined),
    deleteFile: jest.fn(async () => undefined),
    createDirectory: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async () => undefined),
    isRemoteDirEmpty: jest.fn(async () => true),
    recalcChecksum: jest.fn(async (): Promise<string | null> => null),
    downloadFile: jest.fn(async (p: string) => toBuf(bodies[p] ?? '')),
  };
  const createClient = jest.fn(async () => ({ client, features: { isNextcloud: true } }));

  const app = {
    vault: {
      adapter: {
        exists: jest.fn(async (p: string) => p in vault),
        remove: jest.fn(async (p: string) => { delete vault[p]; }),
        mkdir: jest.fn(async () => undefined),
      },
      getAbstractFileByPath: (p: string) => (p in vault ? new TFile(p) : null),
      getAllFolders: () => [] as TFolder[],
    },
    fileManager: { trashFile: jest.fn(async (f: TFile) => { delete vault[f.path]; }) },
  };
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };

  const engine = new SyncEngine({
    app, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false, ...settings },
    localAdapter, stateDB, statusBar, webdavFactory: { createClient },
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  const sync = async (): Promise<SyncSessionSummary> => {
    await engine.syncManual({ manual: true });
    await stateDB.flush();
    return engine.getLastSessionSummary()!;
  };
  return { engine, stateDB, client, vault, names, sync };
}

beforeEach(() => {
  (globalThis as { navigator?: unknown }).navigator ??= {};
});

describe('[SPEC:DEL-3] outbound mass-delete breaker (local deletions to the server)', () => {
  it('refuses to propagate more local deletions than the limit, and records every skipped path', async () => {
    // 30 tracked, 25 gone locally: the automatic limit is max(20, 20% of 30) = 20, and 25 > 20.
    const h = await setup(30, 25);

    const summary = await h.sync();

    expect(h.client.deleteFile).not.toHaveBeenCalled();
    const err = summary.errors.find(e => e.path === BREAKER);
    expect(err).toBeDefined();
    expect(err!.skippedPaths!.all.slice().sort()).toEqual(h.names.slice(0, 25).sort());
  });

  it('keeps the skipped files tracked and does not re-download them, so the decision is left to the user', async () => {
    const h = await setup(30, 25);

    await h.sync();

    for (const p of h.names.slice(0, 25)) {
      expect(h.stateDB.getFile(p)).toBeDefined();
      expect(h.vault[p]).toBeUndefined();
    }
  });

  it('still propagates deletions within the limit', async () => {
    const h = await setup(30, 3);

    const summary = await h.sync();

    expect(h.client.deleteFile).toHaveBeenCalledTimes(3);
    expect(summary.errors.find(e => e.path === BREAKER)).toBeUndefined();
  });

  it('massDeleteLimit = 0 turns the breaker off in this direction too', async () => {
    const h = await setup(30, 25, { massDeleteLimit: 0 });

    await h.sync();

    expect(h.client.deleteFile).toHaveBeenCalledTimes(25);
  });
});

describe('[SPEC:DEL-3] outbound mass-delete breaker in watch mode', () => {
  it('stops propagating single-file deletions once a burst exceeds the limit', async () => {
    const h = await setup(30, 25);

    for (const p of h.names.slice(0, 25)) await h.engine.deleteSingleFile(p);

    // The limit for 30 tracked files is 20: the rest is left for the next full sync, where the breaker holds it.
    expect(h.client.deleteFile).toHaveBeenCalledTimes(20);
    for (const p of h.names.slice(20, 25)) expect(h.stateDB.getFile(p)).toBeDefined();
  });

  it('leaves a folder delete with more tracked files than the limit to the full sync', async () => {
    const h = await setup(25, 25, {}, 'F');

    await h.engine.deleteSingleFolder('F');

    expect(h.client.deleteCollection).not.toHaveBeenCalled();
    expect(h.stateDB.getDir('F')).toBeDefined();
  });
});
