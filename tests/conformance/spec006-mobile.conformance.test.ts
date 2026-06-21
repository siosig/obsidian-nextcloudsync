// Spec-conformance: 006-mobile-support (pure/default-level FRs).
// Runtime platform branching (auto-sync/watch disabled on mobile, progress UI
// suppression) needs the Obsidian app and is covered by the manual checklist;
// here we assert the pure decision helpers and platform-aware defaults.
// NOTE: 006 FR-041 (mobile concurrency=2) is superseded by 015 FR-020 (=3); the
// newer spec governs, so the value is asserted as 3 in spec015-perf.
import { DEFAULT_SETTINGS } from '../../src/types';
import { isCellularBlocked } from '../../src/util/limits';

describe('spec 006 — mobile support (pure logic & defaults)', () => {
  it('FR-051: Wi-Fi-only + cellular blocks sync (non-iOS)', () => {
    expect(isCellularBlocked(true, false, 'cellular')).toBe(true);
  });

  it('FR-051: Wi-Fi-only + wifi does not block', () => {
    expect(isCellularBlocked(true, false, 'wifi')).toBe(false);
  });

  it('FR-052: iOS ignores Wi-Fi-only (never blocks; no network-type API)', () => {
    expect(isCellularBlocked(true, true, 'cellular')).toBe(false);
  });

  it('FR-050: Wi-Fi-only defaults OFF (desktop default)', () => {
    expect(DEFAULT_SETTINGS.syncOnWifiOnly).toBe(false);
  });

  it('FR-012/013: "sync on startup" exists; desktop default is ON', () => {
    expect(typeof DEFAULT_SETTINGS.syncOnStartupEnabled).toBe('boolean');
    expect(DEFAULT_SETTINGS.syncOnStartupEnabled).toBe(true);
  });

  it('FR-060: maxFileSizeMB exists and 0 = unlimited (desktop default)', () => {
    expect(DEFAULT_SETTINGS.maxFileSizeMB).toBe(0);
  });
});
