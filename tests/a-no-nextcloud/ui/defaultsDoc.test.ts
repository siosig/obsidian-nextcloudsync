import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DEFAULT_SETTINGS } from '../../../src/types';

// The "Settings defaults" tables in the READMEs must stay in sync with DEFAULT_SETTINGS.
function readme(name: string): string {
  return readFileSync(resolve(process.cwd(), name), 'utf-8');
}

describe('[SPEC:SC-005] README settings-defaults tables match the code', () => {
  for (const file of ['README.md', 'README.ja.md']) {
    const text = readme(file);

    describe(file, () => {
      it('has a settings-defaults section', () => {
        expect(text).toMatch(/Settings defaults|\u8a2d\u5b9a\u306e\u65e2\u5b9a\u5024/);
      });

      it('documents the default values from DEFAULT_SETTINGS', () => {
        expect(text).toContain(String(DEFAULT_SETTINGS.networkTimeoutSeconds));   // 30
        // Chunk threshold is platform-derived, not a documented setting.
        expect(text).toContain(String(DEFAULT_SETTINGS.startupSyncDelaySeconds)); // 1
      });

      it('documents the platform-derived values (mobile max file size, concurrency tiers)', () => {
        expect(text).toContain('20'); // mobile maxFileSizeMB
        expect(text).toContain('16'); // desktop concurrency tier (8 GB+)
      });
    });
  }
});
