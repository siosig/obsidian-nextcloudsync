// Spec-conformance: 002-nextcloud-feature-extensions (defaults & pure logic).
// LoginFlow polling/timeout (LoginFlowV2.test), versions/locking/chunked network
// behavior (NextcloudClient.*.test + e2e) are covered elsewhere; here we assert
// the spec's default feature gating (FR-017, FR-019).
// Feature 033: chunked upload / file locking / chunk threshold are fixed values (no longer
// user-editable settings). They live in src/util/fixedSyncConfig.ts; defaults asserted here.
import { DEFAULT_SETTINGS } from '../../../src/types';
import { FIXED, chunkThresholdMB } from '../../../src/util/fixedSyncConfig';

describe('spec 002 — nextcloud feature extensions (fixed values, feature 033)', () => {
  it('FR-019: chunked upload is always on', () => {
    expect(FIXED.chunkedUploadEnabled).toBe(true);
  });

  it('FR-017/019: file locking is always off (if-match preconditions replace it)', () => {
    expect(FIXED.fileLockingEnabled).toBe(false);
  });

  it('FR-010: chunk threshold is a positive platform-derived value (chunking start threshold)', () => {
    expect(chunkThresholdMB(false)).toBeGreaterThan(0); // desktop
    expect(chunkThresholdMB(true)).toBeGreaterThan(0);  // mobile
  });
});
