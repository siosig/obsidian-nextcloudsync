// Spec-conformance: 002-nextcloud-feature-extensions (defaults & pure logic).
// LoginFlow polling/timeout (LoginFlowV2.test), versions/locking/chunked network
// behavior (NextcloudClient.*.test + e2e) are covered elsewhere; here we assert
// the spec's default feature gating (FR-017, FR-019).
// Feature 028: these are no longer user settings — they are fixed values in fixedConfig.ts.
import { FIXED } from '../../../src/sync/fixedConfig';

describe('spec 002 — nextcloud feature extensions (fixed values)', () => {
  it('FR-019: chunked upload is fixed ON', () => {
    expect(FIXED.chunkedUploadEnabled).toBe(true);
  });

  it('FR-017/019: file locking is fixed OFF (if-match preconditions replace it)', () => {
    expect(FIXED.fileLockingEnabled).toBe(false);
  });

  it('FR-019: bulk upload is fixed ON', () => {
    expect(FIXED.bulkUploadEnabled).toBe(true);
  });

  it('FR-010: uploadChunkThresholdMB is a positive number (chunking start threshold)', () => {
    expect(typeof FIXED.uploadChunkThresholdMB).toBe('number');
    expect(FIXED.uploadChunkThresholdMB).toBeGreaterThan(0);
  });
});
