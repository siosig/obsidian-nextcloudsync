// Watch-on-edit single-file sync and the size-limit skip notice (docs/spec.md §9.4a).
//
// A watch sync is automatic: it keeps its own tally and logs the skipped file, but never shows a count notice
// and never writes the per-session total line (OSN-6). When it runs next to a manual sync, either deferred until
// that sync ends or alongside it, its skip stays out of the manual sync's count and notice (OSN-9).
//
// The vault holds two over-the-limit files and one file within the limit that the full sync sees, plus the
// watched `w/big.bin`, which is over the limit and hidden from the full sync's scan: it stands for a file created
// after the full sync listed the vault.
import { oversizeSkipNoticeText } from '../../../src/sync/session/OversizeSkipNotifier';
import {
  LIMIT_MB, OVER, UNDER, buildOversizeWorld, notices, perFileSizeNotices, sessionLogLines, skipLogLines, skipNotices,
} from '../support/oversizeWorld';
import type { OversizeWorld } from '../support/oversizeWorld';

const WATCH_PATH = 'w/big.bin';
const WATCH_SKIP_LOG = 'size-limit: skipped upload (2048B > 0.001MB) → w/big.bin';
const DEFERRED_LOG = 'watch: full sync in progress → deferred w/big.bin';
const DRAIN_LOG = 'watch: full sync finished → re-evaluating 1 deferred path(s)';
const MANUAL_SESSION_LOG = 'size-limit: session total=2 trigger=manual notice=shown';
const INCREMENTAL = [false, true];

/** The manual sync's own skips: the two over-the-limit files it can see. */
const MANUAL_SKIPPED = ['up/o-1.bin', 'up/o-2.bin'];

async function watchWorld(incremental: boolean): Promise<OversizeWorld> {
  const w = await buildOversizeWorld({
    local: [['up/o-1.bin', OVER], ['up/o-2.bin', OVER], ['ok/up.md', UNDER], [WATCH_PATH, OVER]],
    incremental,
  });
  w.hiddenFromScan.add(WATCH_PATH);
  return w;
}

/** A promise that stays pending until `release()` is called. */
function gate(): { held: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release };
}

function watchSkipLogs(w: OversizeWorld): string[] {
  return skipLogLines(w.logs).filter(l => l.endsWith(`→ ${WATCH_PATH}`));
}

/** The outcome both OSN-9 cases share: the manual sync's own count notice and tally, and the watch's separate log line. */
function expectWatchSkipKeptApart(w: OversizeWorld): void {
  // One notice, counting only the manual sync's two files.
  expect(skipNotices().map(n => n.message)).toEqual([oversizeSkipNoticeText(2, LIMIT_MB)]);
  expect(perFileSizeNotices()).toHaveLength(0);
  // The manual session's tally does not hold the watched file.
  const tally = w.engine.getLastSessionSummary()?.oversizeSkippedPaths ?? new Set<string>();
  expect([...tally].sort()).toEqual(MANUAL_SKIPPED);
  expect(tally.has(WATCH_PATH)).toBe(false);
  // The watch sync logged its own skip once; the manual sync logged its two.
  expect(watchSkipLogs(w)).toEqual([WATCH_SKIP_LOG]);
  expect(skipLogLines(w.logs)).toHaveLength(3);
  // Only the manual sync wrote a per-session total line.
  expect(sessionLogLines(w.logs)).toEqual([MANUAL_SESSION_LOG]);
  expect(w.remote.has(WATCH_PATH)).toBe(false);
}

beforeEach(() => {
  (globalThis as { navigator?: unknown }).navigator ??= {};
  notices().length = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('[SPEC:OSN-6] a watch sync skips an oversized file silently', () => {
  describe.each(INCREMENTAL)('incremental=%s', (incremental) => {
    it('[SPEC:OSN-6] shows no notice, logs the skip once and writes no session total line', async () => {
      const w = await watchWorld(incremental);

      await w.engine.syncSingleFile(WATCH_PATH);
      await w.stateDB.flush();

      // The watch sync reached the upload decision: it asked the server, found nothing, and did not upload.
      expect(w.client.statFile).toHaveBeenCalledWith(WATCH_PATH);
      expect(w.client.uploadFile).not.toHaveBeenCalled();
      expect(w.remote.has(WATCH_PATH)).toBe(false);

      expect(skipNotices()).toHaveLength(0);
      expect(perFileSizeNotices()).toHaveLength(0);
      expect(skipLogLines(w.logs)).toEqual([WATCH_SKIP_LOG]);
      // A watch sync is not a session: no total line, and no session summary is kept.
      expect(sessionLogLines(w.logs)).toEqual([]);
      expect(w.engine.getLastSessionSummary()).toBeNull();
    });
  });
});

describe('[SPEC:OSN-9] a watch sync next to a manual sync keeps its own tally', () => {
  describe.each(INCREMENTAL)('incremental=%s', (incremental) => {
    it('[SPEC:OSN-9] deferred until the manual sync ends: its skip is not in the manual notice or tally', async () => {
      const w = await watchWorld(incremental);
      const { held, release } = gate();
      w.client.getFiles.mockImplementationOnce(async () => { await held; return w.listing(); });

      const run = w.manual();
      await w.engine.syncSingleFile(WATCH_PATH);

      // The manual sync is still running, so the watch sync was deferred and has recorded nothing yet.
      expect(w.logs).toContain(DEFERRED_LOG);
      expect(w.logs.some(l => l.startsWith('sync: done'))).toBe(false);
      expect(skipLogLines(w.logs)).toEqual([]);
      expect(skipNotices()).toHaveLength(0);

      release();
      await run;
      await w.stateDB.flush();

      // The deferred path was re-evaluated once the run finished.
      expect(w.logs).toContain(DRAIN_LOG);
      expectWatchSkipKeptApart(w);
    });

    it('[SPEC:OSN-9] running alongside the manual sync: its skip is not in the manual notice or tally', async () => {
      const w = await watchWorld(incremental);
      const { held, release } = gate();
      // The watch sync's server lookup stays pending while a whole manual sync runs.
      w.client.statFile.mockImplementationOnce(async () => { await held; return null; });

      const watch = w.engine.syncSingleFile(WATCH_PATH);
      while (w.client.statFile.mock.calls.length === 0) await new Promise(r => setImmediate(r));
      await w.manual();

      // The manual sync is over; the watch sync was not deferred and is still waiting for the server.
      expect(w.logs).not.toContain(DEFERRED_LOG);
      expect(w.logs.some(l => l.startsWith('sync: done'))).toBe(true);
      expect(watchSkipLogs(w)).toEqual([]);
      expect(skipNotices().map(n => n.message)).toEqual([oversizeSkipNoticeText(2, LIMIT_MB)]);

      release();
      await watch;
      await w.stateDB.flush();

      expectWatchSkipKeptApart(w);
    });
  });
});
