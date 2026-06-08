import { App, Plugin, Notice, TFile, TAbstractFile, debounce } from 'obsidian';
import { DavSyncSettings, DEFAULT_SETTINGS, FeatureUnsupportedError } from './types';
import { NextcloudSyncSettingTab } from './settings/SettingTab';
import { SyncEngine } from './sync/SyncEngine';
import { VersionHistoryModal } from './ui/VersionHistoryModal';
import { v4 as uuidv4 } from './util/uuid';

const MIN_OBSIDIAN_VERSION = '1.12.7';

export default class ObsidianNextcloudsync extends Plugin {
  settings!: DavSyncSettings;
  syncEngine?: SyncEngine;

  async onload(): Promise<void> {
    // Obsidian version check
    const currentVersion = (this.app as App & { appVersion?: string }).appVersion ?? '';
    if (currentVersion && this.compareVersions(currentVersion, MIN_OBSIDIAN_VERSION) < 0) {
      new Notice(
        `Nextcloud Sync requires Obsidian ${MIN_OBSIDIAN_VERSION} or later. Current: ${currentVersion}`,
        0,
      );
      return;
    }

    await this.loadSettings();

    // Generate deviceId if not set
    if (!this.settings.deviceId) {
      this.settings.deviceId = uuidv4();
      await this.saveSettings();
    }

    // Initialize SyncEngine (lazy — only when settings are complete)
    if (this.settings.serverUrl && this.settings.username) {
      await this.initSyncEngine();
    }

    this.addSettingTab(new NextcloudSyncSettingTab(this.app, this));

    this.addCommand({
      id: 'sync-now',
      name: 'Sync Now',
      callback: async () => {
        await this.syncEngine?.syncManual();
      },
    });

    this.addCommand({
      id: 'show-version-history',
      name: 'Show version history',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.syncEngine) return false;
        if (checking) return true;
        void this.showVersionHistory(file);
        return true;
      },
    });

    // ウォッチモード: ローカル Markdown 編集を検知して即時同期する。
    // 連続編集での過剰同期を避けるため、最後の編集から 2 秒後に 1 回だけ実行（デバウンス）。
    const debouncedSync = debounce(() => { void this.syncEngine?.syncManual(); }, 2000, true);
    this.registerEvent(
      this.app.vault.on('modify', (file: TAbstractFile) => {
        if (!this.settings.watchOnChangeEnabled) return;
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        debouncedSync();
      }),
    );
  }

  /** アクティブノートのサーバーバージョン履歴を取得して Modal を表示する（US2）。 */
  private async showVersionHistory(file: TFile): Promise<void> {
    const engine = this.syncEngine;
    if (!engine) return;
    try {
      const versions = await engine.listVersions(file.path);
      new VersionHistoryModal(
        this.app,
        file.path,
        versions,
        (version) => engine.restoreVersion(file.path, version),
      ).open();
    } catch (err) {
      if (err instanceof FeatureUnsupportedError) {
        new Notice('No server version history is available for this file.', 6000);
      } else {
        new Notice(`❌ Failed to load version history: ${(err as Error).message}`, 6000);
      }
    }
  }

  async onunload(): Promise<void> {
    this.syncEngine?.stopAutoSync();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<DavSyncSettings>);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async initSyncEngine(): Promise<void> {
    const { LocalAdapter } = await import('./data/LocalAdapter');
    const { StateDB } = await import('./data/StateDB');
    const { StatusBarItem } = await import('./ui/StatusBarItem');
    const { WebDAVFactory } = await import('./network/WebDAVFactory');
    const { loadAppPassword } = await import('./settings/SettingTab');

    const localAdapter = new LocalAdapter(this.app.vault.adapter);
    const pluginDir = `.obsidian/plugins/${this.manifest.id}`;
    const stateDB = new StateDB(this.app.vault.adapter, pluginDir, this.settings.deviceId);
    await stateDB.load();

    const statusBar = new StatusBarItem(this.addStatusBarItem());
    const password = loadAppPassword(this.app, this.settings.passwordSecretId);
    const webdavFactory = new WebDAVFactory(this.app, this.settings, password);

    this.syncEngine = new SyncEngine({
      app: this.app,
      settings: this.settings,
      localAdapter,
      stateDB,
      statusBar,
      webdavFactory,
      pluginDir,
    });

    if (this.settings.syncIntervalMinutes > 0) {
      this.syncEngine.startAutoSync(this.settings.syncIntervalMinutes);
    }
  }

  private compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }
}
