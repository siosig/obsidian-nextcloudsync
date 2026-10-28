// The plugin list is read once, when a sync session begins. A change made while the session runs applies from the
// next sync. (docs/spec.md §7)
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../../src/sync/SyncEngine';
import { StateDB } from '../../../../src/data/StateDB';
import { DEFAULT_SETTINGS, DavSyncSettings, RemoteFileInfo } from '../../../../src/types';
import { sha256 } from '../../../../src/util/hash';
import { TFile } from '../../support/obsidian';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;
const PDIR = `${CONFIG_DIR}/plugins/p`;
const BASE_MTIME = 1_000;
const BUNDLE = ['manifest.json', 'main.js', 'styles.css', 'data.json'];
const bodyOf = (file: string): string =>
  (file === 'manifest.json' ? '{"id":"p","name":"P","version":"1.0.0"}' : `body of ${file}`);

function stateAdapter(): DataAdapter {
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

async function remoteEntry(path: string, body: string): Promise<RemoteFileInfo> {
  return {
    path, fileId: `fid-${path}`, checksum: await sha256(toBuf(body)), etag: null,
    size: enc.encode(body).length, lastModified: BASE_MTIME,
  };
}

async function buildEngine(onGetFiles: (settings: DavSyncSettings) => void) {
  const vault: Record<string, string> = { 'unrelated.md': 'unrelated' };
  const listing: RemoteFileInfo[] = [await remoteEntry('unrelated.md', 'unrelated')];
  const bodies = new Map<string, string>();
  for (const f of BUNDLE) {
    bodies.set(`${PDIR}/${f}`, bodyOf(f));
    listing.push(await remoteEntry(`${PDIR}/${f}`, bodyOf(f)));
  }

  const stateDB = new StateDB(stateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const hash = await sha256(toBuf('unrelated'));
  stateDB.setFile({
    path: 'unrelated.md', localHash: hash, remoteId: hash, idType: 'sha256', size: 9, mtime: BASE_MTIME,
    remoteFileId: 'fid-unrelated.md', isConflicted: false, localMtime: BASE_MTIME, localSize: 9, remoteMtime: BASE_MTIME,
  });

  const settings: DavSyncSettings = {
    ...DEFAULT_SETTINGS, syncOnWifiOnly: false, syncConfigFolder: true, syncedCommunityPlugins: [],
  };
  const sizeOf = (p: string): number => enc.encode(vault[p]).length;
  const localAdapter = {
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
    getFiles: jest.fn(async () => { onGetFiles(settings); return listing; }),
    getDirectories: jest.fn(async () => []),
    getSyncToken: jest.fn(async (): Promise<string | null> => null),
    remoteExists: jest.fn(async (p: string) => listing.some(f => f.path === p)),
    statFile: jest.fn(async () => null),
    uploadFile: jest.fn(async () => undefined),
    deleteFile: jest.fn(async () => undefined),
    createDirectory: jest.fn(async () => undefined),
    isRemoteDirEmpty: jest.fn(async () => true),
    recalcChecksum: jest.fn(async () => null),
    downloadFile: jest.fn(async (p: string) => toBuf(bodies.get(p) ?? '')),
  };
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
    app, settings, localAdapter, stateDB,
    statusBar: { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn(), setPhase: jest.fn() },
    webdavFactory: { createClient: jest.fn(async () => ({ client, features: { isNextcloud: true } })) },
    pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
  } as never);
  const sync = async (): Promise<void> => { await engine.syncManual({ manual: true }); await stateDB.flush(); };
  return { vault, sync };
}

const pluginFiles = (vault: Record<string, string>): string[] =>
  Object.keys(vault).filter(p => p.startsWith(`${CONFIG_DIR}/plugins/`)).sort();

beforeEach(() => {
  (globalThis as { navigator?: unknown }).navigator ??= {};
});

describe('[SPEC:CPS-17] a list change during a sync takes effect from the next sync', () => {
  it('does not write the plugin files in the sync that saw the change, and writes them in the next one', async () => {
    let changeOnce = true;
    const h = await buildEngine((settings) => {
      if (!changeOnce) return;
      changeOnce = false;
      settings.syncedCommunityPlugins = ['p'];
    });

    await h.sync();
    expect(pluginFiles(h.vault)).toEqual([]);

    // data.json is held back in the sync that delivers the code of an enabled plugin (docs/spec.md §7, CPS-13).
    await h.sync();
    expect(pluginFiles(h.vault)).toEqual(BUNDLE.filter(f => f !== 'data.json').map(f => `${PDIR}/${f}`).sort());
  });
});
