// [SPEC:NQT-7] [SPEC:NQT-8] The real SyncEngine and WatchOperations tell the status bar whether a sync is
// automatic (docs/spec.md §11), so a mobile toast stays hidden until a sync has something worth reporting.
//
// Drives the REAL SyncEngine against a real StateDB (in-memory DataAdapter); only the WebDAV client and
// LocalAdapter are test doubles. The harness is copied from watchWifiOnlyWiring.test.ts (it is not exported there).
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, RemoteFileInfo } from '../../../src/types';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
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

function makeLocalAdapter(files: Record<string, string>) {
  return {
    files,
    listVaultFiles: jest.fn(() => [] as Array<{ path: string; size: number; mtime: number }>),
    stat: jest.fn(async (p: string) =>
      (p in files ? { size: enc.encode(files[p]).length, mtime: 1_000 } : null)),
    exists: jest.fn(async (p: string) => p in files),
    read: jest.fn(async (p: string) => files[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(files[p] ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
  };
}

async function buildEngine(files: Record<string, string>) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const localAdapter = makeLocalAdapter(files);

  const getFiles = jest.fn(async (): Promise<RemoteFileInfo[]> => []);
  const getSyncToken = jest.fn(async (): Promise<string | null> => null);
  const statFile = jest.fn(async (): Promise<RemoteFileInfo | null> => null);
  const uploadFile = jest.fn(async () => undefined);
  const deleteFile = jest.fn(async () => undefined);
  const client = { getFiles, getSyncToken, statFile, uploadFile, deleteFile };
  const createClient = jest.fn(async () => ({ client, features: { isNextcloud: false } }));
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn(), setPhase: jest.fn() };

  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
    localAdapter, stateDB, statusBar, webdavFactory: { createClient },
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  return { engine, stateDB, statusBar };
}

/** The arguments of the first `setStatus('syncing', …)` call, or undefined when there was none. */
function firstSyncingCall(setStatus: jest.Mock): unknown[] | undefined {
  return setStatus.mock.calls.find((c) => c[0] === 'syncing');
}

describe('[SPEC:NQT-7] SyncEngine.syncManual tells the status bar whether the run is automatic', () => {
  it('[SPEC:NQT-7] syncManual() without arguments reports an automatic run', async () => {
    const { engine, stateDB, statusBar } = await buildEngine({});

    await engine.syncManual();

    expect(firstSyncingCall(statusBar.setStatus)).toEqual(['syncing', { automatic: true }]);
    await stateDB.flush();
  });

  it('[SPEC:NQT-7] syncManual({ manual: true }) reports a manual run', async () => {
    const { engine, stateDB, statusBar } = await buildEngine({});

    await engine.syncManual({ manual: true });

    expect(firstSyncingCall(statusBar.setStatus)).toEqual(['syncing', { automatic: false }]);
    await stateDB.flush();
  });
});

describe('[SPEC:NQT-8] WatchOperations reports a single-file sync as automatic', () => {
  it('[SPEC:NQT-8] syncSingleFile starts with setStatus("syncing", { automatic: true })', async () => {
    const { engine, stateDB, statusBar } = await buildEngine({ 'note.md': 'body' });

    await engine.syncSingleFile('note.md');

    expect(firstSyncingCall(statusBar.setStatus)).toEqual(['syncing', { automatic: true }]);
    await stateDB.flush(); // drain the debounced requestSave() timer an upload may have armed
  });
});
