// Spec-conformance: 002-nextcloud-feature-extensions (defaults & pure logic).
// LoginFlow polling/timeout (LoginFlowV2.test), versions/locking/chunked network
// behavior (NextcloudClient.*.test + e2e) are covered elsewhere; here we assert
// the spec's default feature gating (FR-017, FR-019).
// Feature 032: these values are now user-editable DavSyncSettings; defaults asserted here.
import { DEFAULT_SETTINGS } from '../../../src/types';

describe('spec 002 — nextcloud feature extensions (DEFAULT_SETTINGS values)', () => {
  it('FR-019: chunked upload defaults ON', () => {
    expect(DEFAULT_SETTINGS.chunkedUploadEnabled).toBe(true);
  });

  it('FR-017/019: file locking defaults OFF (if-match preconditions replace it)', () => {
    expect(DEFAULT_SETTINGS.fileLockingEnabled).toBe(false);
  });

  it('FR-019: bulk upload defaults ON', () => {
    expect(DEFAULT_SETTINGS.bulkUploadEnabled).toBe(true);
  });

  it('FR-010: uploadChunkThresholdMB is a positive number (chunking start threshold)', () => {
    expect(typeof DEFAULT_SETTINGS.uploadChunkThresholdMB).toBe('number');
    expect(DEFAULT_SETTINGS.uploadChunkThresholdMB).toBeGreaterThan(0);
  });
});
