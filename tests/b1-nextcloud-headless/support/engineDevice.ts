// A SyncEngine "device" over an in-memory FakeVault and a real NextcloudClient; the only way to verify
// cross-device behaviour such as empty-directory pruning and concurrent renames.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { StateDB } from '../../../src/data/StateDB';
import { MergeBaseStore } from '../../../src/data/MergeBaseStore';
import { CleanSideStore } from '../../../src/data/CleanSideStore';
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
  cleanSideStore: CleanSideStore;
  client: NextcloudClient;
  settings: DavSyncSettings;
  sync(): Promise<void>;
}

export function makeDevice(
  env: LiveEnv, remoteBase: string, deviceId: string, over: Partial<DavSyncSettings> = {},
  vault: FakeVault = new FakeVault(),
): Device {
  const settings: DavSyncSettings = {
    ...DEFAULT_SETTINGS,
    serverUrl: env.serverUrl,
    username: env.username,
    deviceId,
    ...over,
  };
  const localAdapter = new LocalAdapter(vault.adapter, vault.vault);
  const stateDB = new StateDB(vault.adapter, PLUGIN_DIR, deviceId);
  // Per-device merge base store wired as in production, so b1 runs the real 3-way merge with a true base.
  const baseStore = new MergeBaseStore(vault.adapter, PLUGIN_DIR, deviceId);
  // Clean-side snapshot store wired as in production, so b1 exercises force-resolution recovery across devices.
  const cleanSideStore = new CleanSideStore(vault.adapter, PLUGIN_DIR, deviceId);
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
    cleanSideStore,
    statusBar: noopStatusBar,
    webdavFactory,
    pluginDir: PLUGIN_DIR,
    configDir: CONFIG_DIR,
  } as never);
  return { engine, vault, stateDB, baseStore, cleanSideStore, client, settings, sync: () => engine.syncManual({ manual: true }) };
}

// Models an app restart: a fresh engine over the same vault with every store re-read from disk.
export async function restartDevice(
  env: LiveEnv, remoteBase: string, d: Device, over: Partial<DavSyncSettings> = {},
): Promise<Device> {
  const next = makeDevice(env, remoteBase, d.settings.deviceId, over, d.vault);
  await next.stateDB.load();
  await next.baseStore.load();
  await next.cleanSideStore.load();
  return next;
}
