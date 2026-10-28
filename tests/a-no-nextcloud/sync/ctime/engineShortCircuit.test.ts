// Root-ETag short-circuit vs creation time (docs/spec.md §9.7, §8a.5): a short-circuited sync rebuilds the
// listing from State, so its entries carry no creationTime and must trigger no creation-time work. The scope
// fingerprint version forces one real scan after an upgrade so listings start carrying nc:creation_time.
import { requestUrl, DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../../src/sync/SyncEngine';
import { StateDB } from '../../../../src/data/StateDB';
import { DEFAULT_SETTINGS, DavSyncSettings, RemoteFileInfo } from '../../../../src/types';
import { sha256 } from '../../../../src/util/hash';
import { computeSyncScopeFingerprint } from '../../../../src/sync/plugins/scopeFingerprint';
import { spec } from '../../support/specRef';

void requestUrl;

const PLUGIN_DIR = '.obsidian/plugins/obsidian-nextcloudsync';
const MTIME = 1_000;
const ROOT = 'ROOT-1';
const enc = new TextEncoder();
const toBuf = (text: string): ArrayBuffer => enc.encode(text).buffer as ArrayBuffer;

function makeStateAdapter(): DataAdapter {
  const store: Record<string, string> = {};
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (from: string, to: string) => { store[to] = store[from]; delete store[from]; }),
    stat: jest.fn(), list: jest.fn(), readBinary: jest.fn(), writeBinary: jest.fn(),
  } as unknown as DataAdapter;
}

// A converged one-note vault on a Nextcloud double whose root ETag never changes.
async function build(storedFingerprint: (settings: DavSyncSettings) => string) {
  const files: Record<string, string> = { 'a.md': 'alpha' };
  const db = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev-1');
  await db.load();
  const hash = await sha256(toBuf('alpha'));
  db.setFile({
    path: 'a.md', localHash: hash, remoteId: hash, idType: 'sha256', size: 5, mtime: MTIME,
    remoteFileId: 'fid-a', isConflicted: false, localMtime: MTIME, localSize: 5, remoteMtime: MTIME,
  });
  const settings: DavSyncSettings = { ...DEFAULT_SETTINGS, syncOnWifiOnly: false };
  db.setRemoteRootEtag(ROOT);
  db.setSyncScopeFingerprint(storedFingerprint(settings));
  const sizeOf = (p: string): number => enc.encode(files[p]).length;
  const localAdapter = {
    listVaultFiles: jest.fn(() => Object.keys(files).map((p) => ({ path: p, size: sizeOf(p), mtime: MTIME }))),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async (p: string) => (p in files ? { size: sizeOf(p), mtime: MTIME } : null)),
    exists: jest.fn(async (p: string) => p in files),
    read: jest.fn(async (p: string) => files[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(files[p] ?? '')),
    atomicWrite: jest.fn(async () => undefined), atomicWriteBinary: jest.fn(async () => undefined),
    writeBinary: jest.fn(async () => undefined), remove: jest.fn(async () => undefined),
    creationTimeSupport: jest.fn(async () => 'settable' as const),
    setCreationTime: jest.fn(async () => 'applied' as const),
  };
  const listing: RemoteFileInfo[] = [
    { path: 'a.md', fileId: 'fid-a', checksum: hash, etag: null, size: 5, lastModified: MTIME },
  ];
  const client = {
    getRootEtag: jest.fn(async () => ROOT),
    getFiles: jest.fn(async () => listing),
    getSyncToken: jest.fn(async (): Promise<string | null> => null),
    getDirectories: jest.fn(async () => []),
    remoteExists: jest.fn(async () => true),
    statFile: jest.fn(async () => null),
    downloadFile: jest.fn(async () => toBuf('')),
    uploadFile: jest.fn(async () => undefined),
    createDirectory: jest.fn(async () => undefined),
    isRemoteDirEmpty: jest.fn(async () => true),
    recalcChecksum: jest.fn(async (): Promise<string | null> => null),
    setCreationTime: jest.fn(async () => 'applied' as const),
  };
  const app = {
    vault: {
      adapter: { exists: jest.fn(async (p: string) => p in files), mkdir: jest.fn(async () => undefined) },
      getAbstractFileByPath: () => null, getAllFolders: () => [],
    },
    fileManager: { trashFile: jest.fn(async () => undefined) },
  };
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn(), setPhase: jest.fn() };
  const engine = new SyncEngine({
    app, settings, localAdapter, stateDB: db, statusBar,
    webdavFactory: { createClient: jest.fn(async () => ({ client, features: { isNextcloud: true } })) },
    pluginDir: PLUGIN_DIR, configDir: '.obsidian', pluginsAwaitingRestart: new Set<string>(),
  } as never);
  const sync = async (): Promise<void> => { await engine.syncManual({ manual: true }); await db.flush(); };
  return { db, client, localAdapter, settings, sync };
}

describe('SyncEngine root-ETag short-circuit and creation time', () => {
  it(`${spec('CT-11')} a short-circuited sync (listing rebuilt from State, no creationTime) does no creation-time work`, async () => {
    const env = await build(computeSyncScopeFingerprint);

    await env.sync();
    await env.sync();

    expect(env.client.getFiles).not.toHaveBeenCalled(); // both syncs short-circuited
    expect(env.client.setCreationTime).not.toHaveBeenCalled();
    expect(env.localAdapter.setCreationTime).not.toHaveBeenCalled();
    expect(env.localAdapter.creationTimeSupport).not.toHaveBeenCalled();
  });

  it(`${spec('CT-11')} the sync-scope fingerprint carries the scope-v2 version`, () => {
    expect(computeSyncScopeFingerprint(DEFAULT_SETTINGS)).toContain('scope-v2');
    expect(computeSyncScopeFingerprint(DEFAULT_SETTINGS)).not.toContain('scope-v1');
  });

  it(`${spec('CT-11')} a state saved with the scope-v1 fingerprint real-scans on the first sync after the upgrade`, async () => {
    const env = await build((s) => {
      const parts = JSON.parse(computeSyncScopeFingerprint(s)) as unknown[];
      parts[0] = 'scope-v1';
      return JSON.stringify(parts);
    });

    await env.sync();

    expect(env.client.getFiles).toHaveBeenCalledTimes(1);
    expect(env.db.getSyncScopeFingerprint()).toBe(computeSyncScopeFingerprint(env.settings));
    await env.sync();
    expect(env.client.getFiles).toHaveBeenCalledTimes(1); // converged on the new version: short-circuits again
  });
});
