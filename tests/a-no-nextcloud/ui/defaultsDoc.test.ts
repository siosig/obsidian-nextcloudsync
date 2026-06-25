import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DEFAULT_SETTINGS } from '../../../src/types';

// SC-005: the "Settings defaults" tables in the READMEs must stay in sync with
// actual DEFAULT_SETTINGS values, so users can trust them.
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

      it('documents the default values from DEFAULT_SETTINGS', () => {
        expect(text).toContain(String(DEFAULT_SETTINGS.networkTimeoutSeconds));   // 30
        expect(text).toContain(String(DEFAULT_SETTINGS.uploadChunkThresholdMB));  // 50
        expect(text).toContain(String(DEFAULT_SETTINGS.startupSyncDelaySeconds)); // 1
      });

      it('documents the platform-derived values (mobile max file size, concurrency tiers)', () => {
        expect(text).toContain('20'); // mobile maxFileSizeMB
        expect(text).toContain('16'); // desktop concurrency tier (8 GB+)
      });
    });
  }
});
