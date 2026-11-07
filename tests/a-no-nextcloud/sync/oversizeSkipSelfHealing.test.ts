// Self-healing after the limit is raised (docs/spec.md §9.4a). The same engine, synced again after the user raises
// "Maximum file size (MB)", imports the files it skipped in both directions; the count notice disappears, or shrinks
// to what is still over the limit.
import { oversizeSkipNoticeText } from '../../../src/sync/session/OversizeSkipNotifier';
import { LIMIT_MB, OVER, OVER_SMALL, buildOversizeWorld, notices, skipNotices } from '../support/oversizeWorld';

type SyncPath = 'initial' | 'incremental';
type RaiseCase = 'all-fit' | 'partial';

const PATHS: SyncPath[] = ['initial', 'incremental'];
const CASES: RaiseCase[] = ['all-fit', 'partial'];
// 0.01 MB (10485 bytes) holds both bodies; 0.0015 MB (1572 bytes) holds the 1500-byte one but not the 2048-byte one.
const RAISED_MB: Record<RaiseCase, number> = { 'all-fit': 0.01, partial: 0.0015 };

// Obsidian's Notice mock accumulates across tests; every case starts from an empty list.
beforeEach(() => {
  notices().length = 0;
});

describe.each(PATHS)('[SPEC:OSN-12] raising the limit and syncing again (%s sync)', (syncPath) => {
  it.each(CASES)('imports the skipped files in both directions: %s', async (raiseCase) => {
    const w = await buildOversizeWorld({
      local: [['up/a.bin', OVER_SMALL], ['up/b.bin', OVER]],
      remote: [['down/a.bin', OVER_SMALL], ['down/b.bin', OVER]],
      incremental: syncPath === 'incremental',
    });

    // First manual sync: all four files are over the limit and are reported by one notice.
    await w.manual();
    expect(skipNotices().map(n => n.message)).toEqual([oversizeSkipNoticeText(4, LIMIT_MB)]);
    expect(w.client.uploadFile).not.toHaveBeenCalled();
    expect(w.vault.has('down/a.bin')).toBe(false);
    expect(w.vault.has('down/b.bin')).toBe(false);

    // The user raises the limit in the same settings object; the same engine syncs again.
    notices().length = 0;
    w.settings.maxFileSizeMB = RAISED_MB[raiseCase];
    await w.manual();

    const uploaded = w.client.uploadFile.mock.calls.map(c => c[0]).sort();
    const stillSkipped = [...(w.engine.getLastSessionSummary()?.oversizeSkippedPaths ?? [])].sort();

    if (raiseCase === 'all-fit') {
      expect(uploaded).toEqual(['up/a.bin', 'up/b.bin']);
      expect(w.remote.get('up/a.bin')?.body).toBe(OVER_SMALL);
      expect(w.remote.get('up/b.bin')?.body).toBe(OVER);
      expect(w.vault.get('down/a.bin')?.body).toBe(OVER_SMALL);
      expect(w.vault.get('down/b.bin')?.body).toBe(OVER);
      expect(skipNotices()).toHaveLength(0);
      expect(stillSkipped).toEqual([]);
    } else {
      expect(uploaded).toEqual(['up/a.bin']);
      expect(w.remote.get('up/a.bin')?.body).toBe(OVER_SMALL);
      expect(w.remote.has('up/b.bin')).toBe(false);
      expect(w.vault.get('down/a.bin')?.body).toBe(OVER_SMALL);
      expect(w.vault.has('down/b.bin')).toBe(false);
      expect(skipNotices().map(n => n.message)).toEqual([oversizeSkipNoticeText(2, RAISED_MB.partial)]);
      expect(stillSkipped).toEqual(['down/b.bin', 'up/b.bin']);
    }
  });
});
