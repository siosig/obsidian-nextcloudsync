import { FIXED, chunkThresholdMB } from '../../../src/util/fixedSyncConfig';

// Feature 033: five low-value settings are removed from the UI and pinned to fixed values.
// fixedSyncConfig is the single source of truth for those values.
describe('[SPEC:FX-1] fixed sync config (033)', () => {
  it('pins the three boolean/number fixed values', () => {
    expect(FIXED.fileLockingEnabled).toBe(false);  // If-Match precondition is the lost-update guard
    expect(FIXED.chunkedUploadEnabled).toBe(true);  // still gated by server capability at use-site
    expect(FIXED.maxConflictRegions).toBe(0);       // 0 = unlimited (never cap a clean merge)
  });

  it('derives the upload chunk threshold from the platform', () => {
    expect(chunkThresholdMB(false)).toBe(50); // desktop
    expect(chunkThresholdMB(true)).toBe(20);  // mobile chunks earlier to reduce peak memory
  });
});
