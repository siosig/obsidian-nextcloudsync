// A silent sync (startup sync with notifications disabled) still runs but drives no status surface:
// the engine swaps its active status bar for a no-op, so the mobile toast never appears. This pins that
// wiring at the real SyncEngine level (not a mock of runSyncSession) so a regression that reintroduces
// statusBar calls for the startup path is caught.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS } from '../../../src/types';
import { TFile, TFolder } from '../support/obsidian';

const enc = new TextEncoder();
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';

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

async function buildEngine() {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();

  const vault: Record<string, string> = {};
  const localAdapter = {
    files: vault,
    listVaultFiles: jest.fn(() => [] as { path: string; size: number; mtime: number }[]),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async () => null),
    exists: jest.fn(async () => false),
    read: jest.fn(async (p: string) => vault[p] ?? ''),
    readBinary: jest.fn(async (p: string) => enc.encode(vault[p] ?? '').buffer as ArrayBuffer),
    atomicWrite: jest.fn(async (p: string, d: string) => { vault[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { vault[p] = new TextDecoder().decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { vault[p] = new TextDecoder().decode(d); }),
    setMtime: jest.fn(),
    ignore: jest.fn(),
    remove: jest.fn(async (p: string) => { delete vault[p]; }),
  };

  const client = {
    getRootEtag: jest.fn(async () => null as string | null),
    getFiles: jest.fn(async () => []),
    getSyncToken: jest.fn(async (): Promise<string | null> => null),
    remoteExists: jest.fn(async () => false),
    statFile: jest.fn(async () => null),
    uploadFile: jest.fn(async () => undefined),
    deleteFile: jest.fn(async () => undefined),
    getDirectories: jest.fn(async () => []),
    createDirectory: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async () => undefined),
    isRemoteDirEmpty: jest.fn(async () => true),
    recalcChecksum: jest.fn(async () => null),
    downloadFile: jest.fn(async () => enc.encode('x').buffer as ArrayBuffer),
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
    fileManager: {
      trashFile: jest.fn(async () => undefined),
    },
  };

  const logger = { log: jest.fn(async () => undefined) };
  const statusBar = {
    setStatus: jest.fn(),
    setProgress: jest.fn(),
    setConflictCount: jest.fn(),
    setErrorCount: jest.fn(),
    setSyncComplete: jest.fn(),
  };

  const engine = new SyncEngine({
    app, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
    localAdapter, stateDB, statusBar, webdavFactory: { createClient }, logger,
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  return { engine, statusBar };
}

beforeEach(() => {
  (globalThis as { navigator?: unknown }).navigator ??= {};
});

describe('silent sync (startup notifications off)', () => {
  it('a normal sync drives the status surface', async () => {
    const { engine, statusBar } = await buildEngine();
    await engine.syncManual({ manual: true });
    expect(statusBar.setStatus).toHaveBeenCalledWith('syncing');
    expect(statusBar.setSyncComplete).toHaveBeenCalled();
  });

  it('a silent sync runs without touching the status surface', async () => {
    const { engine, statusBar } = await buildEngine();
    await engine.syncManual({ manual: true, silent: true });
    expect(statusBar.setStatus).not.toHaveBeenCalled();
    expect(statusBar.setProgress).not.toHaveBeenCalled();
    expect(statusBar.setSyncComplete).not.toHaveBeenCalled();
  });

  it('a silent sync does not leak into the next non-silent sync', async () => {
    const { engine, statusBar } = await buildEngine();
    await engine.syncManual({ manual: true, silent: true });
    statusBar.setStatus.mockClear();
    statusBar.setSyncComplete.mockClear();
    await engine.syncManual({ manual: true });
    expect(statusBar.setStatus).toHaveBeenCalledWith('syncing');
    expect(statusBar.setSyncComplete).toHaveBeenCalled();
  });
});
