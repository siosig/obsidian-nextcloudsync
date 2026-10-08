// [SPEC:MWM-5] The real SyncEngine hands its own "Wi-Fi only" decision to watch mode (docs/spec.md §5.7c).
//
// Drives the REAL SyncEngine against a real StateDB (in-memory DataAdapter); only the WebDAV client
// and LocalAdapter are test doubles. The harness is copied from watchPendingDuringFullSync.test.ts
// (it is not exported there), with `syncOnWifiOnly` made a parameter and the full-sync gate removed.
import { DataAdapter, Platform } from 'obsidian';
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

/** In-memory local vault used only for the watch-mode single-file call. */
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
    setMtime: jest.fn(),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
  };
}

/** Builds a real SyncEngine wired to a real StateDB, with "Wi-Fi only" set as given. */
async function buildEngine(files: Record<string, string>, syncOnWifiOnly: boolean) {
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
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };

  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly },
    localAdapter, stateDB, statusBar, webdavFactory: { createClient },
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  return { engine, stateDB, localAdapter, client, createClient };
}

function setConnectionType(type: string | undefined): void {
  if (type === undefined) {
    delete (globalThis.navigator as unknown as Record<string, unknown>).connection;
    return;
  }
  Object.defineProperty(globalThis.navigator, 'connection', { value: { type }, configurable: true, writable: true });
}

describe('[SPEC:MWM-5] SyncEngine wires its "Wi-Fi only" decision into watch mode', () => {
  beforeEach(() => {
    // testEnvironment is 'node'; isBlockedByWifiOnly reads navigator.connection.
    (globalThis as { navigator?: unknown }).navigator ??= {};
  });

  afterEach(() => {
    delete (globalThis.navigator as unknown as Record<string, unknown>).connection;
    Platform.isIosApp = false;
    Platform.isMobile = false;
  });

  it.each([
    [true, 'cellular', false, 0],
    [true, 'wifi', false, 1],
    [true, undefined, false, 1],
    [false, 'cellular', false, 1],
    [true, 'cellular', true, 1],
  ] as Array<[boolean, string | undefined, boolean, number]>)(
    '[SPEC:MWM-5] syncOnWifiOnly=%s type=%s iOS=%s → connects %i time(s)',
    async (syncOnWifiOnly, type, isIosApp, expectedConnects) => {
      const { engine, stateDB, createClient } = await buildEngine({ 'note.md': 'body' }, syncOnWifiOnly);
      setConnectionType(type);
      Platform.isIosApp = isIosApp;
      Platform.isMobile = isIosApp;

      await engine.syncSingleFile('note.md');

      expect(createClient).toHaveBeenCalledTimes(expectedConnects);
      await stateDB.flush(); // drain the debounced requestSave() timer an upload may have armed
    },
  );
});
