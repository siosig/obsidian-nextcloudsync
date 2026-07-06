import { isWatchModeActive } from '../../../src/util/settingsMigration';

// G7-2 (feature 055): watch mode must never fire on mobile at RUNTIME, regardless of the
// persisted `watchOnChangeEnabled` value. `applyMobileFirstRunDefaults` only defaults this to
// `false` on a brand-new install (tested separately in mobileFirstRunDefaults.test.ts); a value
// copied in from another device (e.g. a synced `.obsidian` folder) or carried over from an older
// profile can still persist `true` on a mobile install. main.ts's `guard`/`watchOn` vault-event
// gates now consult isWatchModeActive instead of reading `watchOnChangeEnabled` directly, so this
// is the single decision point that must hold the constraint.
describe('isWatchModeActive (G7-2)', () => {
  it('is active on desktop when the setting is on', () => {
    expect(isWatchModeActive(true, false)).toBe(true);
  });

  it('is inactive on desktop when the setting is off', () => {
    expect(isWatchModeActive(false, false)).toBe(false);
  });

  it('is inactive on mobile even when the persisted setting is true (the bug scenario)', () => {
    // e.g. a `.obsidian` folder copied/synced from a desktop profile that had watch mode on.
    expect(isWatchModeActive(true, true)).toBe(false);
  });

  it('is inactive on mobile when the setting is off (the common case)', () => {
    expect(isWatchModeActive(false, true)).toBe(false);
  });

  it.each([
    [true, false, true],
    [false, false, false],
    [true, true, false],
    [false, true, false],
  ])('watchOnChangeEnabled=%s isMobile=%s → %s', (enabled, isMobile, expected) => {
    expect(isWatchModeActive(enabled as boolean, isMobile as boolean)).toBe(expected);
  });
});
