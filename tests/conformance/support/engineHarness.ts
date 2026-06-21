// Builds a SyncEngine wired to an in-memory vault + a shared FakeRemote, so multiple
// "devices" can sync against one remote folder for spec-conformance integration tests.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { StateDB } from '../../../src/data/StateDB';
import { SyncHistoryStore } from '../../../src/data/SyncHistoryStore';
import { NullStatusBar } from '../../../src/ui/NullStatusBar';
import { WebDAVFactory } from '../../../src/network/WebDAVFactory';
import { DavSyncSettings, DEFAULT_SETTINGS } from '../../../src/types';
import { FakeVault } from './fakeVault';
import { FakeRemote } from './fakeRemote';

const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
const CONFIG_DIR = '.obsidian';

export interface Device {
  engine: SyncEngine;
  vault: FakeVault;
  stateDB: StateDB;
  localAdapter: LocalAdapter;
  sync: () => Promise<void>;
}

/** Construct a device (engine + state) bound to the given shared remote. */
export async function makeDevice(
  deviceId: string,
  remote: FakeRemote,
  overrides: Partial<DavSyncSettings> = {},
): Promise<Device> {
  const vault = new FakeVault();
  const settings: DavSyncSettings = {
    ...DEFAULT_SETTINGS,
    deviceId,
    serverUrl: 'https://example.invalid/remote.php/dav/files/u',
    username: 'u',
    ...overrides,
  };
  const localAdapter = new LocalAdapter(vault.adapter, vault.vault);
  const stateDB = new StateDB(vault.adapter, PLUGIN_DIR, deviceId);
  await stateDB.load();
  const historyStore = new SyncHistoryStore(vault.adapter, PLUGIN_DIR);
  await historyStore.load();
  const webdavFactory = {
    createClient: async () => ({ client: remote, features: await remote.connect() }),
  } as unknown as WebDAVFactory;

  const engine = new SyncEngine({
    app: vault.app,
    settings,
    localAdapter,
    stateDB,
    statusBar: new NullStatusBar(),
    historyStore,
    webdavFactory,
    pluginDir: PLUGIN_DIR,
    configDir: CONFIG_DIR,
  });

  return { engine, vault, stateDB, localAdapter, sync: () => engine.syncManual() };
}
