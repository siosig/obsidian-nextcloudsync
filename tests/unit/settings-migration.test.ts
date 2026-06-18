import { migrateLegacyDebugMode } from '../../src/util/settingsMigration';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../src/types';

function freshSettings(): DavSyncSettings {
  return { ...DEFAULT_SETTINGS };
}

describe('migrateLegacyDebugMode', () => {
  it('enables the debug log at level "debug" when legacy debugMode was true', () => {
    const settings = freshSettings();
    migrateLegacyDebugMode({ debugMode: true }, settings);
    expect(settings.debugLogEnabled).toBe(true);
    expect(settings.debugLogLevel).toBe('debug');
  });

  it('leaves defaults when legacy debugMode was false', () => {
    const settings = freshSettings();
    migrateLegacyDebugMode({ debugMode: false }, settings);
    expect(settings.debugLogEnabled).toBe(false);
    expect(settings.debugLogLevel).toBe('error');
  });

  it('leaves defaults when no legacy debugMode key is present', () => {
    const settings = freshSettings();
    migrateLegacyDebugMode({}, settings);
    expect(settings.debugLogEnabled).toBe(false);
    expect(settings.debugLogLevel).toBe('error');
  });

  it('does not override an already-saved debugLogEnabled value', () => {
    const settings = freshSettings();
    settings.debugLogEnabled = false;
    // User explicitly saved debugLogEnabled previously → legacy flag must not re-enable it.
    migrateLegacyDebugMode({ debugMode: true, debugLogEnabled: false }, settings);
    expect(settings.debugLogEnabled).toBe(false);
  });
});
