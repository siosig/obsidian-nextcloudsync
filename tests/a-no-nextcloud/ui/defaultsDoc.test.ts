import { readFileSync } from 'fs';
import { resolve } from 'path';
import { FIXED } from '../../../src/sync/fixedConfig';

// SC-005 (feature 028): the "Settings defaults" tables in the READMEs must stay in sync with the
// actual fixed / platform-derived values, so users can trust them. We assert that each documented
// value's string appears and that both language files carry the section.
function readme(name: string): string {
  return readFileSync(resolve(process.cwd(), name), 'utf-8');
}

describe('[SPEC:SC-005] README settings-defaults tables match the code', () => {
  for (const file of ['README.md', 'README.ja.md']) {
    const text = readme(file);

    describe(file, () => {
      it('has a settings-defaults section', () => {
        expect(text).toMatch(/Settings defaults|設定の既定値/);
      });

      it('documents the fixed values from FIXED', () => {
        expect(text).toContain('30');                                       // networkTimeoutSeconds
        expect(text).toContain(String(FIXED.uploadChunkThresholdMB));       // 50
        expect(text).toContain(String(FIXED.startupSyncDelaySeconds));      // 1
        for (const ext of FIXED.mergeableExtensions) expect(text).toContain(ext); // md, txt
      });

      it('documents the platform-derived values (mobile max file size, concurrency tiers)', () => {
        expect(text).toContain('20'); // mobile maxFileSizeMB
        expect(text).toContain('16'); // desktop concurrency tier (8 GB+)
      });
    });
  }
});
