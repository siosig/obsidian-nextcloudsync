import { SyncEngine } from '../../../src/sync/SyncEngine';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { DavSyncSettings, DEFAULT_SETTINGS, ConfigSyncCategories, SyncSessionSummary, RemoteFileInfo, FileState } from '../../../src/types';
import { DataAdapter, Vault } from 'obsidian';
import { StateDB } from '../../../src/data/StateDB';
import { sha256 } from '../../../src/util/hash';
import { TFile } from '../support/obsidian';

function makeDataAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
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
    ...overrides,
  } as unknown as DataAdapter;
}

function makeEmptyVault(adapter: DataAdapter): Vault {
  return {
    adapter,
    getAbstractFileByPath: jest.fn(() => null),
    getFiles: jest.fn(() => []),
    trash: jest.fn(),
  } as unknown as Vault;
}

// Config-folder sync wiring in SyncEngine: local scan injects enabled-category files, and hard
// exclusions (plugins/, the plugin dir) survive every toggle, including the remote-deletion scope guard.

const enc = new TextEncoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer;
const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;

function settings(syncConfigFolder: boolean, configSync: Partial<ConfigSyncCategories>): DavSyncSettings {
  return {
    configDir: CONFIG_DIR,
    syncConfigFolder,
    configSync: { bookmarks: false, others: false, ...configSync },
  } as unknown as DavSyncSettings;
}

function makeSummary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
    deletedCount: 0, mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], pluginsNeedingRestart: [], errors: [],
  };
}

describe('SyncEngine local-scan injection (config folder)', () => {
  it('injects an enabled-category file that exists, and excludes disabled categories', async () => {
    // Vault is empty (config-folder files are not Vault-tracked); stat provides the file's presence.
    const present = new Set<string>([`${CONFIG_DIR}/appearance.json`]);
    const rawAdapter = makeDataAdapter({
      stat: jest.fn(async (p: string) => (present.has(p) ? { size: 3, mtime: 1 } as never : null)),
      readBinary: jest.fn(async () => toBuf('{}')),
    });
    const vault = makeEmptyVault(rawAdapter);
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = new SyncEngine({
      app: {}, settings: settings(true, { others: true }), localAdapter,
      stateDB: {}, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
    } as never);

    const scan = await (engine as unknown as {
      scanLocalFiles(): Promise<Map<string, unknown>>;
    }).scanLocalFiles();

    expect(scan.has(`${CONFIG_DIR}/appearance.json`)).toBe(true); // Other settings ON + on disk → injected
    expect(scan.has(`${CONFIG_DIR}/app.json`)).toBe(false);       // app.json absent on disk
    expect(scan.has(`${CONFIG_DIR}/hotkeys.json`)).toBe(false);   // hotkeys.json absent on disk
  });

  it('injects nothing under the config folder when the master is OFF', async () => {
    const rawAdapter = makeDataAdapter({
      stat: jest.fn(async () => ({ size: 3, mtime: 1 } as never)),
      readBinary: jest.fn(async () => toBuf('{}')),
    });
    const vault = makeEmptyVault(rawAdapter);
    const localAdapter = new LocalAdapter(rawAdapter, vault);
    const engine = new SyncEngine({
      app: {}, settings: settings(false, { others: true }), localAdapter,
      stateDB: {}, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
    } as never);

    const scan = await (engine as unknown as {
      scanLocalFiles(): Promise<Map<string, unknown>>;
    }).scanLocalFiles();

    expect([...scan.keys()].some(p => p.startsWith(`${CONFIG_DIR}/`))).toBe(false);
  });
});

describe('SyncEngine remote-deletion scope guard (config folder hard exclusions)', () => {
  function buildDeletionHarness(s: DavSyncSettings) {
    const remove = jest.fn(async () => undefined);
    const trashFile = jest.fn(async () => undefined);
    const exists = jest.fn(async () => true);
    const getAbstractFileByPath = jest.fn(() => null);
    const deleteFile = jest.fn();
    const app = {
      vault: { adapter: { exists, remove }, getAbstractFileByPath },
      fileManager: { trashFile },
    };
    const engine = new SyncEngine({
      app,
      settings: s,
      // getAllFiles/getAllDirs/deleteDir: the deletion sink forgets a trashed folder's
      // whole subtree, so it enumerates tracking even for a plain file path.
      stateDB: { deleteFile, getAllFiles: () => [], getAllDirs: () => [], deleteDir: jest.fn() },
      configDir: CONFIG_DIR,
      localAdapter: {}, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR,
    } as never);
    const invoke = (path: string) =>
      (engine as unknown as {
        processRemoteDeletion(p: string, s: SyncSessionSummary): Promise<void>;
      }).processRemoteDeletion(path, makeSummary());
    return { invoke, remove };
  }

  const allOn = settings(true, { others: true, bookmarks: true });

  it('ignores deletion of a community plugin file even with ALL categories on', async () => {
    const h = buildDeletionHarness(allOn);
    await h.invoke(`${CONFIG_DIR}/plugins/some-plugin/main.js`);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("ignores deletion of this plugin's own state DB even with ALL categories on", async () => {
    const h = buildDeletionHarness(allOn);
    await h.invoke(`${PLUGIN_DIR}/state.json`);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('still processes deletion of an enabled config file (appearance.json)', async () => {
    const h = buildDeletionHarness(allOn);
    await h.invoke(`${CONFIG_DIR}/appearance.json`);
    expect(h.remove).toHaveBeenCalledTimes(1); // in scope → legitimate deletion proceeds
  });
});

// A `.obsidian` JSON conflict flows through the single dispatch as an Other File: json is not in
// autoMergeFileTypes, so it takes otherFileStrategy, which is JSON-safe (never writes markers).
// Equal mtime is a no-op, re-evaluated next sync. (docs/spec.md §7)
describe('[SPEC:CSF-12] config JSON conflict resolves via Other File / latest-mtime (no special branch)', () => {
  const enc2 = new TextEncoder();
  const toBuf2 = (s: string): ArrayBuffer => enc2.encode(s).buffer;

  function harness(localMtime: number, remoteMtime: number) {
    const setFile = jest.fn();
    const atomicWriteBinary = jest.fn(async () => undefined);
    const localAdapter = {
      stat: jest.fn(async () => ({ size: 7, mtime: localMtime })),
      read: jest.fn(async () => '{"a":1}'),
      readBinary: jest.fn(async () => toBuf2('{"a":1}')),
      atomicWrite: jest.fn(async () => undefined),
      atomicWriteBinary,
    };
    const setRemoteRootEtag = jest.fn();
    const stateDB = { setFile, getFile: jest.fn(() => undefined), setRemoteRootEtag };
    const client = { downloadFile: jest.fn(async () => toBuf2('{"a":2}')) };
    const upload = jest.fn(async () => 'uploaded' as const);
    const engine = new SyncEngine({
      app: {}, settings: { ...DEFAULT_SETTINGS, deviceId: 'dev-abcd' }, localAdapter, stateDB,
      statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
    } as never);
    (engine as unknown as { client: unknown }).client = client;
    (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = { upload };
    const remote: RemoteFileInfo = {
      path: `${CONFIG_DIR}/appearance.json`, fileId: 'f', checksum: 'c', etag: 'e',
      size: toBuf2('{"a":2}').byteLength, lastModified: remoteMtime,
    };
    const invoke = (base: FileState | undefined, summary: SyncSessionSummary) =>
      (engine as unknown as {
        handleConflict(p: string, b: FileState | undefined, r: RemoteFileInfo, id: string, t: FileState['idType'], s: SyncSessionSummary): Promise<void>;
      }).handleConflict(`${CONFIG_DIR}/appearance.json`, base, remote, 'c', 'sha256', summary);
    return { invoke, atomicWriteBinary, upload, setFile, setRemoteRootEtag };
  }

  it('[SPEC:CSF-12] remote newer → local overwritten by remote (no markers, JSON-safe)', async () => {
    const h = harness(1000, 2000);
    const summary = makeSummary();
    await h.invoke(undefined, summary);
    expect(h.atomicWriteBinary).toHaveBeenCalledTimes(2); // the conflict copy, then the overwrite
    expect(summary.downloadedCount).toBe(1);
  });

  it('[SPEC:CSF-12] equal mtime → no-op success (converges next sync, no error, not conflicted)', async () => {
    const base: FileState = {
      path: `${CONFIG_DIR}/appearance.json`, localHash: 'lh', remoteId: 'rh', idType: 'sha256',
      size: 7, mtime: 1500, remoteFileId: 'f', isConflicted: false,
    };
    const h = harness(1500, 1500);
    const summary = makeSummary();
    await h.invoke(base, summary);
    expect(h.atomicWriteBinary).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(summary.errorCount).toBe(0);
    expect(summary.conflictedCount).toBe(0);
    expect(h.setFile).not.toHaveBeenCalled();
    // [SPEC:ES-11]: the tie must invalidate the root-ETag short-circuit so the next sync re-scans instead of
    // rebuilding from stale State and silently uploading the local JSON over the remote.
    expect(h.setRemoteRootEtag).toHaveBeenCalledWith(null);
  });
});

// Engine wiring for listed community plugins: only the four bundle files directly under a listed plugin folder
// take part in a sync, in every direction. (docs/spec.md §7)
describe('[SPEC:CPS-2] community plugin files in the engine', () => {
  const dec = new TextDecoder();
  const BASE_MTIME = 1_000;
  const PDIR = `${CONFIG_DIR}/plugins/p`;
  const BUNDLE = ['manifest.json', 'main.js', 'styles.css', 'data.json'];
  const bodyOf = (file: string): string =>
    (file === 'manifest.json' ? '{"id":"p","name":"P","version":"1.0.0"}' : `body of ${file}`);

  function stateAdapter(): DataAdapter {
    const store: Record<string, string> = {};
    return makeDataAdapter({
      read: jest.fn(async (p: string) => store[p] ?? ''),
      write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
      exists: jest.fn(async (p: string) => p in store),
      remove: jest.fn(async (p: string) => { delete store[p]; }),
      rename: jest.fn(async (f: string, t: string) => { store[t] = store[f]; delete store[f]; }),
    });
  }

  async function remoteEntry(path: string, body: string): Promise<RemoteFileInfo> {
    return {
      path, fileId: `fid-${path}`, checksum: await sha256(toBuf(body)), etag: null,
      size: enc.encode(body).length, lastModified: BASE_MTIME,
    };
  }

  async function track(stateDB: StateDB, path: string, body: string): Promise<void> {
    const hash = await sha256(toBuf(body));
    const size = enc.encode(body).length;
    stateDB.setFile({
      path, localHash: hash, remoteId: hash, idType: 'sha256', size, mtime: BASE_MTIME,
      remoteFileId: `fid-${path}`, isConflicted: false, localMtime: BASE_MTIME, localSize: size, remoteMtime: BASE_MTIME,
    });
  }

  async function build(vault: Record<string, string>, listing: RemoteFileInfo[], list: string[]) {
    const stateDB = new StateDB(stateAdapter(), PLUGIN_DIR, 'dev1');
    await stateDB.load();
    // One tracked, unchanged note keeps the session off the first-sync route.
    vault['unrelated.md'] = 'unrelated';
    await track(stateDB, 'unrelated.md', 'unrelated');
    listing.push(await remoteEntry('unrelated.md', 'unrelated'));
    const sizeOf = (p: string): number => enc.encode(vault[p]).length;
    const localAdapter = {
      // Obsidian's vault index omits dot paths, so the config folder is reached only through stat.
      listVaultFiles: jest.fn(() => Object.keys(vault).filter(p => !p.startsWith('.'))
        .map(p => ({ path: p, size: sizeOf(p), mtime: BASE_MTIME }))),
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
      remoteExists: jest.fn(async (p: string) => listing.some(f => f.path === p)),
      statFile: jest.fn(async () => null),
      uploadFile: jest.fn(async () => undefined),
      deleteFile: jest.fn(async () => undefined),
      createDirectory: jest.fn(async () => undefined),
      isRemoteDirEmpty: jest.fn(async () => true),
      recalcChecksum: jest.fn(async () => null),
      downloadFile: jest.fn(async (p: string) => toBuf(remoteBodies.get(p) ?? '')),
    };
    const remoteBodies = new Map<string, string>();
    const app = {
      vault: {
        adapter: {
          exists: jest.fn(async (p: string) => p in vault),
          remove: jest.fn(async (p: string) => { delete vault[p]; }),
          mkdir: jest.fn(async () => undefined),
        },
        getAbstractFileByPath: (p: string) => (p in vault ? new TFile(p) : null),
        getAllFolders: () => [],
      },
      fileManager: { trashFile: jest.fn(async (f: TFile) => { delete vault[f.path]; }) },
    };
    const engine = new SyncEngine({
      app, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false, syncConfigFolder: true, syncedCommunityPlugins: list },
      localAdapter, stateDB, statusBar: { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() },
      webdavFactory: { createClient: jest.fn(async () => ({ client, features: { isNextcloud: true } })) },
      pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
    } as never);
    const sync = async (): Promise<void> => { await engine.syncManual({ manual: true }); await stateDB.flush(); };
    return { engine, stateDB, vault, client, remoteBodies, sync };
  }

  const pluginPaths = (vault: Record<string, string>): string[] =>
    Object.keys(vault).filter(p => p.startsWith(`${CONFIG_DIR}/plugins/`)).sort();

  beforeEach(() => {
    (globalThis as { navigator?: unknown }).navigator ??= {};
  });

  it('writes only the three code files of a listed plugin when it exists on the server', async () => {
    const listing: RemoteFileInfo[] = [];
    const h = await build({}, listing, ['p']);
    const remotePaths = [
      ...BUNDLE.map(f => `${PDIR}/${f}`), `${PDIR}/sub/x.js`, `${PDIR}/README.md`,
    ];
    for (const path of remotePaths) {
      const body = path.endsWith('/sub/x.js') ? 'sub' : path.endsWith('README.md') ? 'readme' : bodyOf(path.slice(PDIR.length + 1));
      h.remoteBodies.set(path, body);
      listing.push(await remoteEntry(path, body));
    }

    await h.sync();

    // data.json is held back in the sync that delivers the code of an enabled plugin (docs/spec.md §7, CPS-13).
    expect(pluginPaths(h.vault)).toEqual(BUNDLE.filter(f => f !== 'data.json').map(f => `${PDIR}/${f}`).sort());
    expect(h.client.downloadFile).not.toHaveBeenCalledWith(`${PDIR}/data.json`);
    expect(h.client.downloadFile).not.toHaveBeenCalledWith(`${PDIR}/sub/x.js`);
    expect(h.client.downloadFile).not.toHaveBeenCalledWith(`${PDIR}/README.md`);
  });

  it('removes a tracked file of a listed plugin locally when it is deleted on the server', async () => {
    const vault: Record<string, string> = {};
    const listing: RemoteFileInfo[] = [];
    const h = await build(vault, listing, ['p']);
    for (const f of BUNDLE) {
      vault[`${PDIR}/${f}`] = bodyOf(f);
      await track(h.stateDB, `${PDIR}/${f}`, bodyOf(f));
      if (f !== 'main.js') listing.push(await remoteEntry(`${PDIR}/${f}`, bodyOf(f)));
    }

    await h.sync();

    expect(`${PDIR}/main.js` in vault).toBe(false);
    expect(pluginPaths(vault)).toEqual(['manifest.json', 'styles.css', 'data.json'].map(f => `${PDIR}/${f}`).sort());
  });

  it('adds only the four bundle files of a listed plugin to the upload candidates', async () => {
    const vault: Record<string, string> = {};
    for (const f of BUNDLE) vault[`${PDIR}/${f}`] = bodyOf(f);
    vault[`${PDIR}/sub/x.js`] = 'sub';
    vault[`${PDIR}/README.md`] = 'readme';
    vault[`${CONFIG_DIR}/plugins/q/main.js`] = 'q code';
    vault[`${CONFIG_DIR}/plugins/q/manifest.json`] = '{"id":"q","version":"1.0.0"}';
    const h = await build(vault, [], ['p']);

    await h.sync();

    const uploaded = h.client.uploadFile.mock.calls.map((c) => (c as unknown as [string])[0]).sort();
    expect(uploaded).toEqual(BUNDLE.map(f => `${PDIR}/${f}`).sort());
  });
});
