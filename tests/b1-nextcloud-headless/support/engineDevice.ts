// Builds a full SyncEngine "device" wired to an in-memory FakeVault (local) and a REAL
// NextcloudClient (remote, localhost Docker). Lets b1 drive syncManual end to end — the only
// way to verify cross-device behaviour like empty-directory pruning and concurrent renames.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { StateDB } from '../../../src/data/StateDB';
import { MergeBaseStore } from '../../../src/data/MergeBaseStore';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';
import { DavSyncSettings, DEFAULT_SETTINGS, NextcloudFeatures } from '../../../src/types';
import { LiveEnv } from './env';
import { FakeVault } from './fakeVault';

const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
const CONFIG_DIR = '.obsidian';

const noopStatusBar = {
  setStatus(): void {}, setProgress(): void {}, setConflictCount(): void {},
  setErrorCount(): void {}, setSyncComplete(): void {},
};

export interface Device {
  engine: SyncEngine;
  vault: FakeVault;
  stateDB: StateDB;
  baseStore: MergeBaseStore;
  client: NextcloudClient;
  settings: DavSyncSettings;
  sync(): Promise<void>;
}

/** Construct an independent device (own vault + state) sharing one remote workspace folder. */
export function makeDevice(
  env: LiveEnv, remoteBase: string, deviceId: string, over: Partial<DavSyncSettings> = {},
): Device {
  const settings: DavSyncSettings = {
    ...DEFAULT_SETTINGS,
    serverUrl: env.serverUrl,
    username: env.username,
    deviceId,
    ...over,
  };
  const vault = new FakeVault();
  const localAdapter = new LocalAdapter(vault.adapter, vault.vault);
  const stateDB = new StateDB(vault.adapter, PLUGIN_DIR, deviceId);
  // Feature 038: per-device merge base store (last-synced bodies), wired exactly like production so
  // b1 exercises the real 3-way merge with a true base across devices.
  const baseStore = new MergeBaseStore(vault.adapter, PLUGIN_DIR, deviceId);
  const client = new NextcloudClient(settings, env.appPassword, remoteBase);
  const webdavFactory = {
    async createClient(): Promise<{ client: IWebDAVClient; features: NextcloudFeatures }> {
      const features = await client.connect();
      return { client, features };
    },
  };
  const engine = new SyncEngine({
    app: vault.app,
    settings,
    localAdapter,
    stateDB,
    baseStore,
    statusBar: noopStatusBar,
    webdavFactory,
    pluginDir: PLUGIN_DIR,
    configDir: CONFIG_DIR,
  } as never);
  return { engine, vault, stateDB, baseStore, client, settings, sync: () => engine.syncManual({ manual: true }) };
}
