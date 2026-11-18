// [SPEC:DEP-2] [SPEC:DEP-3] The app-password SecretComponent stores the chosen secret ID, shows the
// default ID when none is stored, and maps a cleared selection (null) to the unset value ''.
import type { App } from 'obsidian';
import { Setting, SecretComponent } from '../support/obsidian';
import { NextcloudSyncSettingTab, loadAppPassword } from '../../../src/settings/SettingTab';
import { DEFAULT_SETTINGS } from '../../../src/types';

const DEFAULT_ID = 'obsidian-nextcloudsync-password';

function setup(stored = '') {
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, passwordSecretId: stored },
    saveSettings: jest.fn(async () => {}),
  };
  const app = {} as unknown as App;
  const tab = new NextcloudSyncSettingTab(app, plugin as never);
  const update = jest.fn();
  tab.update = update;
  const setting = new Setting(tab.containerEl);
  tab.renderAppPassword(setting as never);
  const sc = setting.components[0] as SecretComponent;
  return { plugin, update, sc };
}

function makeFakeApp() {
  const getSecret = jest.fn(() => 'pw');
  const app = { secretStorage: { getSecret }, loadLocalStorage: jest.fn(() => null) } as unknown as App;
  return { app, getSecret };
}

describe('[SPEC:DEP-2] app password SecretComponent selection', () => {
  it('imports the settings tab', () => {
    expect(typeof NextcloudSyncSettingTab).toBe('function');
  });

  it('stores a chosen secret ID, saves once and rebuilds once', async () => {
    const { plugin, update, sc } = setup();
    await sc.changeCb!('my-secret');
    expect(plugin.settings.passwordSecretId).toBe('my-secret');
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('shows the default ID when nothing is stored', () => {
    expect(setup('').sc.value).toBe(DEFAULT_ID);
  });

  it('shows the stored ID when one is stored', () => {
    expect(setup('x').sc.value).toBe('x');
  });
});

describe('[SPEC:DEP-3] cleared SecretComponent selection', () => {
  it('stores the unset value as a string, saves once and rebuilds once', async () => {
    const { plugin, update, sc } = setup();
    await sc.changeCb!(null);
    expect(plugin.settings.passwordSecretId).toBe('');
    expect(typeof plugin.settings.passwordSecretId).toBe('string');
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('returns to the unset value after a stored ID is cleared (self-healing)', async () => {
    const { plugin, sc } = setup();
    await sc.changeCb!('my-secret');
    expect(plugin.settings.passwordSecretId).toBe('my-secret');
    await sc.changeCb!(null);
    expect(plugin.settings.passwordSecretId).toBe('');
  });

  it('resolves an empty stored ID to the default secret ID at read time', () => {
    const { app, getSecret } = makeFakeApp();
    loadAppPassword(app, '');
    expect(getSecret).toHaveBeenCalledWith(DEFAULT_ID);
  });

  it('reads with the default secret ID right after the selection is cleared', async () => {
    const { plugin, sc } = setup('my-secret');
    await sc.changeCb!(null);
    const { app, getSecret } = makeFakeApp();
    loadAppPassword(app, plugin.settings.passwordSecretId);
    expect(getSecret).toHaveBeenCalledWith(DEFAULT_ID);
  });

  it('keeps an empty-string selection as the empty string', async () => {
    const { plugin, sc } = setup('my-secret');
    await sc.changeCb!('');
    expect(plugin.settings.passwordSecretId).toBe('');
  });
});

describe('[SPEC:APW-4] a live reader keeps the legacy fallback order', () => {
  it('falls back to the legacy value, then follows the secret as it changes', () => {
    const secrets = new Map<string, string>();
    const app = {
      secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null },
      loadLocalStorage: jest.fn(() => 'legacy-pw'),
    } as unknown as App;
    const settings = { passwordSecretId: 'my-secret' };
    const reader = () => loadAppPassword(app, settings.passwordSecretId);

    // (a) No secret stored: the legacy localStorage value is used.
    expect(reader()).toBe('legacy-pw');

    // (b) The same reader picks up a secret stored later.
    secrets.set('my-secret', 'new-pw');
    expect(reader()).toBe('new-pw');

    // (c) An empty secret counts as missing and falls back to the legacy value.
    secrets.set('my-secret', '');
    expect(reader()).toBe('legacy-pw');
  });
});
