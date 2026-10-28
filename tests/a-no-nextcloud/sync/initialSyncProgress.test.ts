// A first sync of a large vault spends minutes listing, hashing and comparing before any transfer. Each step is
// named in the status bar so the plugin does not look hung, and files seeded as unchanged count toward the progress.
//
// Drives the REAL SyncEngine against a real StateDB (in-memory DataAdapter); only the WebDAV client and
// LocalAdapter are test doubles. Harness shape from statusBarAutomaticWiring.test.ts.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, RemoteFileInfo } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';

const enc = new TextEncoder();
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
    listVaultFiles: jest.fn(() => Object.entries(files).map(([path, body]) => ({ path, size: enc.encode(body).length, mtime: 1_000 }))),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async (p: string) => (p in files ? { size: enc.encode(files[p]).length, mtime: 1_000 } : null)),
    exists: jest.fn(async (p: string) => p in files),
    readBinary: jest.fn(async (p: string) => toBuf(files[p] ?? '')),
  };
}

describe('SyncEngine first sync reports every step to the status bar', () => {
  // testEnvironment is 'node'; isBlockedByWifiOnly reads navigator.connection.
  beforeAll(() => { (globalThis as { navigator?: unknown }).navigator ??= {}; });

  it('names listing, scan, checksum, compare and folder steps, and counts unchanged files', async () => {
    const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
    await stateDB.load();
    const body = 'same on both sides';
    const localAdapter = makeLocalAdapter({ 'a.md': body, 'b.md': body });
    const sum = await sha256(toBuf(body));
    const remoteFiles: RemoteFileInfo[] = ['a.md', 'b.md'].map((path) => ({
      path, fileId: path, checksum: null, etag: 'e', size: enc.encode(body).length, lastModified: 2_000,
    }));

    const client = {
      getFiles: jest.fn(async () => remoteFiles),
      getDirectories: jest.fn(async () => []),
      getSyncToken: jest.fn(async () => null),
      recalcChecksum: jest.fn(async () => sum),
    };
    const createClient = jest.fn(async () => ({ client, features: { isNextcloud: false } }));
    const events: string[] = [];
    const statusBar = {
      setStatus: jest.fn(), setSyncComplete: jest.fn(),
      setPhase: jest.fn((label: string) => { events.push(label); }),
      setProgress: jest.fn((done: number, total: number, label?: string) => { events.push(`${label ?? ''} ${done}/${total}`); }),
    };

    const engine = new SyncEngine({
      app: { vault: { getAllFolders: () => [] } }, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
      localAdapter, stateDB, statusBar, webdavFactory: { createClient },
      pluginDir: PLUGIN_DIR, configDir: '.obsidian',
    } as never);

    await engine.syncManual({ manual: true });
    await stateDB.flush();

    expect(statusBar.setSyncComplete).toHaveBeenCalledWith(0, 0, 0, 0);
    expect(stateDB.getAllFiles().map(f => f.path).sort()).toEqual(['a.md', 'b.md']);
    expect(events).toEqual([
      'Listing server',
      'Scanning vault',
      'Checking server 0/2', 'Checking server 1/2', 'Checking server 2/2',
      'Comparing 0/2', 'Comparing 1/2', 'Comparing 2/2',
      ' 0/2', ' 1/2', ' 2/2', // both files seeded as unchanged, no transfer
      'Syncing folders',
    ]);
  });
});
