// Direct tests for the per-session over-the-limit tally kept by SyncJournal (docs/spec.md §9.4a).
// recordOversizeSkip is the only writer of SyncSessionSummary.oversizeSkippedPaths: it deduplicates by
// path, logs the first record of each path once, and never throws (a failing logger must not break a sync).
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import type { OversizeSkip } from '../../../../src/types';

interface LogEntry { m: string; level?: string }

const LIMIT_MB = 0.001;
const SKIPPED_PREFIX = 'size-limit: skipped ';

function skip(path: string, direction: OversizeSkip['direction'], sizeBytes = 2048): OversizeSkip {
  return { path, sizeBytes, limitMB: LIMIT_MB, direction };
}

function journalWithLogger() {
  const entries: LogEntry[] = [];
  const logger = {
    log: jest.fn(async (m: string, level?: string) => { entries.push({ m, level }); }),
  };
  const journal = new SyncJournal({ logger });
  return { journal, entries, logger };
}

function skippedLines(entries: LogEntry[]): string[] {
  return entries.map((e) => e.m).filter((m) => m.startsWith(SKIPPED_PREFIX));
}

describe('[SPEC:OSN-4][SPEC:OSN-7] SyncJournal.recordOversizeSkip', () => {
  describe('[SPEC:OSN-4] the tally on a new summary', () => {
    it('[SPEC:OSN-4] starts as an empty Set', () => {
      const { journal } = journalWithLogger();
      const summary = journal.newSummary();
      expect(summary.oversizeSkippedPaths).toBeInstanceOf(Set);
      expect(summary.oversizeSkippedPaths.size).toBe(0);
    });

    it('[SPEC:OSN-4] is not shared between summaries', () => {
      const { journal } = journalWithLogger();
      const first = journal.newSummary();
      const second = journal.newSummary();
      expect(second.oversizeSkippedPaths).not.toBe(first.oversizeSkippedPaths);
    });
  });

  describe('[SPEC:OSN-4][SPEC:OSN-7] recording one skip', () => {
    it('[SPEC:OSN-4][SPEC:OSN-7] adds the path and logs exactly one line in the documented format', () => {
      const { journal, entries } = journalWithLogger();
      const summary = journal.newSummary();

      journal.recordOversizeSkip(summary, { path: 'a.bin', sizeBytes: 2048, limitMB: LIMIT_MB, direction: 'upload' });

      expect(summary.oversizeSkippedPaths.size).toBe(1);
      expect(summary.oversizeSkippedPaths.has('a.bin')).toBe(true);
      expect(entries).toHaveLength(1);
      expect(entries[0].m).toBe('size-limit: skipped upload (2048B > 0.001MB) → a.bin');
      // Debug is the logger's default level, so the line is passed with no level or with 'debug'.
      expect([undefined, 'debug']).toContain(entries[0].level);
    });

    it('[SPEC:OSN-7] writes the direction, the byte size and the limit as given', () => {
      const { journal, entries } = journalWithLogger();
      const summary = journal.newSummary();

      journal.recordOversizeSkip(summary, {
        path: 'Attachments/video.mp4', sizeBytes: 31457280, limitMB: 20, direction: 'download',
      });

      expect(entries.map((e) => e.m)).toEqual([
        'size-limit: skipped download (31457280B > 20MB) → Attachments/video.mp4',
      ]);
    });
  });

  describe('[SPEC:OSN-4][SPEC:OSN-7] deduplication by path', () => {
    it('[SPEC:OSN-4][SPEC:OSN-7] counts and logs a path once even when the direction differs', () => {
      const { journal, entries } = journalWithLogger();
      const summary = journal.newSummary();

      journal.recordOversizeSkip(summary, skip('a.bin', 'upload'));
      journal.recordOversizeSkip(summary, skip('a.bin', 'download'));

      expect(summary.oversizeSkippedPaths.size).toBe(1);
      expect(entries).toHaveLength(1);
      expect(entries[0].m).toContain('skipped upload');
    });

    it('[SPEC:OSN-4][SPEC:OSN-7] ignores repeated records of the same path, whatever size or limit they carry', () => {
      const { journal, entries } = journalWithLogger();
      const summary = journal.newSummary();

      journal.recordOversizeSkip(summary, skip('a.bin', 'upload', 2048));
      journal.recordOversizeSkip(summary, skip('a.bin', 'upload', 2048));
      journal.recordOversizeSkip(summary, { path: 'a.bin', sizeBytes: 9999, limitMB: 0.002, direction: 'upload' });

      expect(summary.oversizeSkippedPaths.size).toBe(1);
      expect(skippedLines(entries)).toHaveLength(1);
    });
  });

  describe('[SPEC:OSN-4][SPEC:OSN-7] adding up the directions', () => {
    it('[SPEC:OSN-4][SPEC:OSN-7] counts upload, download and conflict-path skips of different files into one tally', () => {
      const { journal, entries } = journalWithLogger();
      const summary = journal.newSummary();

      journal.recordOversizeSkip(summary, skip('up.bin', 'upload'));
      journal.recordOversizeSkip(summary, skip('down.bin', 'download'));
      // The conflict path records the remote size without fetching the body; it is a download-direction skip.
      journal.recordOversizeSkip(summary, skip('conflict.bin', 'download', 4096));

      expect(summary.oversizeSkippedPaths.size).toBe(3);
      expect([...summary.oversizeSkippedPaths].sort()).toEqual(['conflict.bin', 'down.bin', 'up.bin']);
      // One debug line per counted path: the number of lines equals the count.
      expect(skippedLines(entries)).toHaveLength(3);
    });
  });

  describe('[SPEC:OSN-4][SPEC:OSN-7] per-summary isolation', () => {
    it('[SPEC:OSN-4] a new summary does not carry over what an earlier summary recorded', () => {
      const { journal } = journalWithLogger();
      const first = journal.newSummary();
      journal.recordOversizeSkip(first, skip('a.bin', 'upload'));
      expect(first.oversizeSkippedPaths.size).toBe(1);

      const second = journal.newSummary();

      expect(second.oversizeSkippedPaths.size).toBe(0);
      expect(first.oversizeSkippedPaths.size).toBe(1);
    });

    it('[SPEC:OSN-4][SPEC:OSN-7] the same path is logged again in a new summary and leaves the old one untouched', () => {
      const { journal, entries } = journalWithLogger();
      const first = journal.newSummary();
      journal.recordOversizeSkip(first, skip('a.bin', 'upload'));

      const second = journal.newSummary();
      journal.recordOversizeSkip(second, skip('a.bin', 'upload'));

      expect(second.oversizeSkippedPaths.size).toBe(1);
      expect(first.oversizeSkippedPaths.size).toBe(1);
      expect(skippedLines(entries)).toHaveLength(2);
    });
  });

  describe('[SPEC:OSN-7] never throws', () => {
    it('[SPEC:OSN-7] works without a logger and still records the path', () => {
      const journal = new SyncJournal({});
      const summary = journal.newSummary();

      expect(() => journal.recordOversizeSkip(summary, skip('a.bin', 'upload'))).not.toThrow();

      expect(summary.oversizeSkippedPaths.has('a.bin')).toBe(true);
      expect(summary.oversizeSkippedPaths.size).toBe(1);
    });

    it('[SPEC:OSN-4][SPEC:OSN-7] does not throw when logger.log throws synchronously, and still records the path', () => {
      const logger = {
        log: jest.fn((): Promise<void> => { throw new Error('logger exploded'); }),
      };
      const journal = new SyncJournal({ logger });
      const summary = journal.newSummary();

      expect(() => journal.recordOversizeSkip(summary, skip('a.bin', 'upload'))).not.toThrow();

      expect(logger.log).toHaveBeenCalledTimes(1);
      expect(summary.oversizeSkippedPaths.has('a.bin')).toBe(true);
      expect(summary.oversizeSkippedPaths.size).toBe(1);
    });

    it('[SPEC:OSN-4][SPEC:OSN-7] does not throw when logger.log rejects, and still records the path', async () => {
      const logger = {
        log: jest.fn((): Promise<void> => Promise.reject(new Error('disk full'))),
      };
      const journal = new SyncJournal({ logger });
      const summary = journal.newSummary();

      expect(() => journal.recordOversizeSkip(summary, skip('a.bin', 'download'))).not.toThrow();
      // Let the rejected promise settle so an unhandled rejection would surface inside this test.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(logger.log).toHaveBeenCalledTimes(1);
      expect(summary.oversizeSkippedPaths.has('a.bin')).toBe(true);
      expect(summary.oversizeSkippedPaths.size).toBe(1);
    });

    it('[SPEC:OSN-4][SPEC:OSN-7] keeps counting later paths after a logger failure', () => {
      const logger = {
        log: jest.fn((): Promise<void> => { throw new Error('logger exploded'); }),
      };
      const journal = new SyncJournal({ logger });
      const summary = journal.newSummary();

      journal.recordOversizeSkip(summary, skip('a.bin', 'upload'));
      journal.recordOversizeSkip(summary, skip('b.bin', 'download'));
      journal.recordOversizeSkip(summary, skip('a.bin', 'download'));

      expect(summary.oversizeSkippedPaths.size).toBe(2);
      // Only the first record of each path reaches the logger.
      expect(logger.log).toHaveBeenCalledTimes(2);
    });
  });
});
