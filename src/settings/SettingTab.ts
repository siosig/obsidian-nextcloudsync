import { App, Platform, PluginSettingTab, Setting, Notice, SecretComponent, TextComponent, SliderComponent } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type ObsidianNextcloudsync from '../main';
import { LoginFlowError, DavSyncSettings } from '../types';
import { parseMergeableExtensions, formatMergeableExtensions } from '../util/mergeableExtensions';
import { LoginFlowV2 } from '../auth/LoginFlowV2';
import { normalizeExcludedFolder } from '../util/excludedFolders';
import { normalizeNumericInput } from '../util/numericInput';
import {
  buildSettingDefinitions,
  type NumberSliderOptions,
  type SettingDefinitionsHost,
} from './settingDefinitions';

// Adapter only: the rows live as data in settingDefinitions.ts because Obsidian 1.13.0 builds the settings search index
// from getSettingDefinitions() alone. display() is not kept as a fallback: it is only called when the definitions come
// back empty (obsidian.d.ts:6633), which minAppVersion 1.13.0 rules out.

// Default secret ID in SecretStorage; users can pick another via "Link…".
const DEFAULT_PASSWORD_SECRET_ID = 'obsidian-nextcloudsync-password';
// localStorage key where older versions stored the password; read only for migration.
const LEGACY_CREDENTIALS_KEY = 'obsidian-nextcloudsync-password';

export class NextcloudSyncSettingTab extends PluginSettingTab implements SettingDefinitionsHost {
  constructor(app: App, private readonly plugin: ObsidianNextcloudsync) {
    super(app, plugin);
  }


  get settings(): DavSyncSettings { return this.plugin.settings; }
  get isMobile(): boolean { return Platform.isMobile; }
  get isIosApp(): boolean { return Platform.isIosApp; }
  get configDir(): string { return this.app.vault.configDir; }
  get vaultName(): string { return this.app.vault.getName(); }

  // Needs a non-empty password STRING: loadLocalStorage returns '' for a missing key and `'' != null` is true,
  // so a bare null check would wrongly report "ready".
  get isSignedIn(): boolean {
    const s = this.plugin.settings;
    const pw = loadAppPassword(this.app, s.passwordSecretId);
    return s.serverUrl.trim().length > 0
      && s.username.trim().length > 0
      && typeof pw === 'string' && pw.length > 0;
  }


  getSettingDefinitions(): SettingDefinitionItem[] {
    return buildSettingDefinitions(this);
  }

  // Resolved by key path (dotted keys address nested values, e.g. configSync.bookmarks) so a `key` cannot drift
  // from its stored value without the layer-a integrity check noticing.
  getControlValue(key: string): unknown {
    return key.split('.').reduce<unknown>(
      (obj, seg) => (obj == null ? undefined : (obj as Record<string, unknown>)[seg]),
      this.plugin.settings as unknown,
    );
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const path = key.split('.');
    const last = path.pop()!;
    const target = path.reduce<Record<string, unknown>>(
      (obj, seg) => obj[seg] as Record<string, unknown>,
      this.plugin.settings as unknown as Record<string, unknown>,
    );
    target[last] = value;
    await this.plugin.saveSettings();
    // Re-arm the auto-sync timer immediately so a new interval takes effect without a reload.
    if (key === 'syncIntervalMinutes') this.plugin.applyAutoSyncInterval();
  }


  runSyncNow(): unknown { return this.plugin.runSyncNow(); }
  runRemoteMirror(): unknown { return this.plugin.runRemoteMirror(); }
  resetVaultIndex(): unknown { return this.plugin.resetVaultIndex(); }
  openSyncStatus(): unknown { return this.plugin.openSyncStatus(); }
  startLoginFlow(): unknown { return this.runLoginFlow(); }

  syncTargetUrl(): string {
    const base = this.plugin.settings.serverUrl.trim().replace(/\/+$/, '');
    if (!base) return '(enter the Server URL above)';
    return `${base}/${this.app.vault.getName()}`;
  }

  async addExcludedFolder(raw: string): Promise<void> {
    const norm = normalizeExcludedFolder(raw);
    if (!norm) { new Notice('Enter a folder path inside the vault.'); return; }
    const list = this.plugin.settings.excludedFolders ?? [];
    if (list.includes(norm)) { new Notice(`"${norm}" is already excluded.`); return; }
    this.plugin.settings.excludedFolders = [...list, norm];
    await this.plugin.saveSettings();
    // The row set itself changed, so refreshDomState() is not enough — update() rebuilds it.
    this.update();
  }

  async removeExcludedFolder(folder: string): Promise<void> {
    this.plugin.settings.excludedFolders =
      (this.plugin.settings.excludedFolders ?? []).filter((f) => f !== folder);
    await this.plugin.saveSettings();
    this.update();
  }


  renderNotice(setting: Setting, text: string, cls?: string): void {
    setting.settingEl.empty();
    setting.settingEl.addClass('setting-item-description');
    if (cls) setting.settingEl.addClass(cls);
    setting.settingEl.setText(text);
  }

  renderReadOnly(setting: Setting, value: string, cls?: string): void {
    setting.addText((text) => text.setValue(value).setDisabled(true));
    if (cls) setting.descEl.addClass(cls);
  }

  // Only the secret's reference ID is kept in data.json; the declarative control set has no secret type.
  renderAppPassword(setting: Setting): void {
    setting.addComponent((el) => new SecretComponent(this.app, el)
      .setValue(this.plugin.settings.passwordSecretId || DEFAULT_PASSWORD_SECRET_ID)
      .onChange(async (secretId) => {
        this.plugin.settings.passwordSecretId = secretId;
        await this.plugin.saveSettings();
        // Sign-in state gates the banner's visibility and "Sync now", so rebuild.
        this.update();
      }));
  }

  // Stored as string[], so it needs a parse/format round-trip.
  renderExtensionList(setting: Setting): void {
    setting.addText((text) => text
      .setPlaceholder('Comma-separated extensions')
      .setValue(formatMergeableExtensions(this.plugin.settings.autoMergeFileTypes))
      .onChange(async (value) => {
        this.plugin.settings.autoMergeFileTypes = parseMergeableExtensions(value);
        await this.plugin.saveSettings();
      }));
  }

  // Uses the built-in folder suggester's filter (SettingFolderControl.filter, obsidian.d.ts:6349) rather than a custom AbstractInputSuggest subclass.
  renderAddExcludedFolder(setting: Setting): void {
    let input: TextComponent | null = null;
    setting.addText((text) => {
      input = text;
      text.setPlaceholder('Example: attachments/large media');
    });
    setting.addButton((btn) => btn
      .setButtonText('Add')
      .setCta()
      .onClick(() => { void this.addExcludedFolder(input?.getValue() ?? ''); }));
  }

  // The numeric input exists because the slider's coarse step puts some values out of reach on touch and an off-grid default
  // cannot be re-selected once moved. SettingSliderControl has no companion input, so this row stays imperative.
  renderNumberSlider(setting: Setting, opts: NumberSliderOptions): void {
    const numInput = setting.controlEl.createEl('input', {
      type: 'number',
      cls: 'ncs-slider-num',
      attr: { 'aria-label': setting.nameEl.textContent ?? '' },
    });
    numInput.min = String(opts.min);
    numInput.max = String(opts.max);
    numInput.step = '1'; // precise: any integer in range, independent of the slider's coarse step
    numInput.value = String(opts.get());

    let sliderRef: SliderComponent | undefined;
    setting.addSlider((slider) => {
      sliderRef = slider;
      slider
        .setLimits(opts.min, opts.max, opts.step)
        .setValue(opts.get())
        .onChange(async (value) => {
          opts.set(value);
          numInput.value = String(value);
          await this.plugin.saveSettings();
          await opts.apply?.();
        });
    });

    // Commit on blur/Enter, not per keystroke, so typing "25" is not clamped on the intermediate "2".
    // Invalid input reverts to the last value.
    numInput.addEventListener('change', () => {
      void (async () => {
        const value = normalizeNumericInput(numInput.value, opts.min, opts.max, opts.get());
        opts.set(value);
        numInput.value = String(value);
        sliderRef?.setValue(value);
        await this.plugin.saveSettings();
        await opts.apply?.();
      })();
    });
  }


  // The password goes to SecretStorage and is never saved in plaintext in data.json.
  private async runLoginFlow(): Promise<void> {
    void this.plugin.logger.log('login: "Log in via browser" clicked');
    const serverUrl = this.plugin.settings.serverUrl.trim();
    if (!serverUrl) {
      void this.plugin.logger.log('login: aborted — server URL empty');
      new Notice('Please enter the server URL first.');
      return;
    }
    const serverBaseUrl = serverUrl.replace(/\/remote\.php.*$/, '').replace(/\/$/, '');

    try {
      void this.plugin.logger.log('login: start() POST →');
      const init = await LoginFlowV2.start(serverBaseUrl);
      void this.plugin.logger.log('login: start() ok (loginUrl received)');
      const opened = window.open(init.loginUrl, '_blank');
      void this.plugin.logger.log(`login: window.open → ${opened ? 'opened' : 'BLOCKED (returned null)'}`);
      new Notice('Waiting for browser approval… (up to 3 minutes)', 8000);

      void this.plugin.logger.log('login: polling started');
      const result = await LoginFlowV2.poll(init);
      void this.plugin.logger.log(`login: poll finished — status=${result.status}`);
      if (result.status === 'success') {
        this.plugin.settings.username = result.loginName;
        saveAppPassword(this.app, DEFAULT_PASSWORD_SECRET_ID, result.appPassword);
        this.plugin.settings.passwordSecretId = DEFAULT_PASSWORD_SECRET_ID;
        await this.plugin.saveSettings();
        await this.plugin.initSyncEngine();
        new Notice(`✅ Logged in as ${result.loginName}`, 6000);
        // Sign-in state changes which rows are visible, so the definitions must be rebuilt —
        // refreshDomState() only re-evaluates predicates against the rows already rendered.
        this.update();
      } else if (result.status === 'timeout') {
        new Notice('⏱️ login timed out. Please try again.', 6000);
      } else {
        new Notice('This server does not support login flow. Please enter an app password manually.', 8000);
      }
    } catch (err) {
      void this.plugin.logger.log(`login: ERROR — ${(err as Error).message}`, 'error');
      if (err instanceof LoginFlowError && err.reason === 'unsupported') {
        new Notice('This server does not support login flow. Please enter an app password manually.', 8000);
      } else {
        new Notice(`❌ Login failed: ${(err as Error).message}`, 6000);
      }
    }
  }
}

export function loadAppPassword(app: App, secretId: string): string | null {
  const id = secretId || DEFAULT_PASSWORD_SECRET_ID;
  const secret = app.secretStorage.getSecret(id);
  if (secret) return secret;
  // Migration fallback: use the legacy localStorage value if it remains.
  return app.loadLocalStorage(LEGACY_CREDENTIALS_KEY) as string | null;
}

function saveAppPassword(app: App, secretId: string, value: string): void {
  const id = secretId || DEFAULT_PASSWORD_SECRET_ID;
  app.secretStorage.setSecret(id, value);
}
