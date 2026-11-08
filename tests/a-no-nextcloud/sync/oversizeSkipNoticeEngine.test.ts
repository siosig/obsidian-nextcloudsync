// Engine-level tests for the size-limit skip notice (docs/spec.md §9.4a). Across the first-sync and incremental
// paths and every sync trigger, an over-the-limit file is skipped without a per-file notice, counted once per
// path, logged once, and reported by a single count notice that only a manual sync shows.
import { makeResumeSyncHandler } from '../../../src/util/appResume';
import { OVERSIZE_SKIP_NOTICE_MS, oversizeSkipNoticeText } from '../../../src/sync/session/OversizeSkipNotifier';
import {
  LIMIT_MB, OVER, UNDER, buildOversizeWorld, notices, perFileSizeNotices, sessionLogLines, skipLogLines, skipNotices,
} from '../support/oversizeWorld';
import type { OversizeWorld } from '../support/oversizeWorld';

type SyncPath = 'initial' | 'incremental';
type Trigger = 'manual' | 'startup' | 'interval' | 'resume';
type Direction = 'upload' | 'download' | 'both' | 'conflict';
type Kind = 'upload' | 'download' | 'conflict';
type SessionTrigger = 'manual' | 'automatic';
type Pair = [string, string];

interface Seed { local: Pair[]; remote: Pair[] }

const PATHS: SyncPath[] = ['initial', 'incremental'];
const TRIGGERS: Trigger[] = ['manual', 'startup', 'interval', 'resume'];
const COUNTS = [0, 1, 3, 1000];
const DIRECTIONS: Direction[] = ['upload', 'download', 'both', 'conflict'];
const CASES: Array<[number, Direction]> = COUNTS.flatMap(n => DIRECTIONS.map((d): [number, Direction] => [n, d]));
const SESSION_TRIGGERS: SessionTrigger[] = ['manual', 'automatic'];

// Which kinds of over-the-limit files each direction seeds; the expected skip count is `n` per kind.
const KINDS_OF: Record<Direction, Kind[]> = {
  upload: ['upload'],
  download: ['download'],
  both: ['upload', 'download'],
  conflict: ['upload', 'download', 'conflict'],
};

// The mtime the world gives every seeded file; files added after the world is built reuse it.
const SEED_MTIME = 1_000;
const CONFLICT_LOCAL = 'l'.repeat(300);
const CASE_TIMEOUT_MS = 120_000;

/** `n` files named `<dir>/<prefix>-1.bin` .. `<dir>/<prefix>-n.bin`, all with the same body. */
function numbered(dir: string, prefix: string, n: number, body: string): Pair[] {
  return Array.from({ length: n }, (_, i): Pair => [`${dir}/${prefix}-${i + 1}.bin`, body]);
}

function seedFor(kind: Kind, n: number): Seed {
  switch (kind) {
    case 'upload':
      return { local: [...numbered('up', 'o', n, OVER), ['ok/up.md', UNDER]], remote: [] };
    case 'download':
      return { local: [], remote: [...numbered('down', 'o', n, OVER), ['ok/down.md', UNDER]] };
    case 'conflict':
      return {
        local: [...numbered('cf', 'o', n, CONFLICT_LOCAL), ['ok/cf.md', 'local\n']],
        remote: [...numbered('cf', 'o', n, OVER), ['ok/cf.md', 'remote\n']],
      };
  }
}

function seedWorld(direction: Direction, n: number): Seed {
  const seeds = KINDS_OF[direction].map(kind => seedFor(kind, n));
  return { local: seeds.flatMap(s => s.local), remote: seeds.flatMap(s => s.remote) };
}

/** Starts one sync the way the given trigger does and waits until it, and the state flush after it, finish. */
async function runTrigger(w: OversizeWorld, trigger: Trigger): Promise<void> {
  if (trigger === 'manual') {
    await w.manual();
    return;
  }
  if (trigger === 'startup') {
    // The startup sync calls syncManual() with no argument (src/main.ts).
    await w.automatic();
    return;
  }
  const syncSpy = jest.spyOn(w.engine, 'syncManual');
  if (trigger === 'interval') {
    const timer: { tick?: () => void } = {};
    const intervalSpy = jest.spyOn(globalThis, 'setInterval').mockImplementation(((cb: () => void) => {
      timer.tick = cb;
      return 0 as never;
    }) as never);
    let intervalMs: unknown;
    try {
      w.engine.startAutoSync(15);
      intervalMs = intervalSpy.mock.calls[0]?.[1];
    } finally {
      intervalSpy.mockRestore();
    }
    expect(intervalMs).toBe(15 * 60 * 1000);
    expect(timer.tick).toBeDefined();
    timer.tick?.();
    expect(syncSpy).toHaveBeenCalledTimes(1);
    await syncSpy.mock.results[0].value;
    await w.stateDB.flush();
    w.engine.stopAutoSync();
  } else {
    makeResumeSyncHandler({
      getEngine: () => w.engine, getLastSyncTime: () => 0, now: () => 10 ** 12, log: () => undefined,
    })();
    expect(syncSpy).toHaveBeenCalledTimes(1);
    await syncSpy.mock.results[0].value;
    await w.stateDB.flush();
  }
  // Interval and resume syncs are automatic: syncManual() is called with no argument.
  expect(syncSpy.mock.calls[0]).toEqual([]);
}

function runSession(w: OversizeWorld, trigger: SessionTrigger): Promise<void> {
  return trigger === 'manual' ? w.manual() : w.automatic();
}

function sessionLine(total: number, trigger: SessionTrigger): string {
  return `size-limit: session total=${total} trigger=${trigger} notice=${trigger === 'manual' ? 'shown' : 'suppressed'}`;
}

beforeEach(() => {
  notices().length = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('[SPEC:OSN-1][SPEC:OSN-2][SPEC:OSN-4][SPEC:OSN-6][SPEC:OSN-7] size-limit skips across sync paths and triggers', () => {
  describe.each(PATHS)('%s sync', (syncPath) => {
    describe.each(TRIGGERS)('%s trigger', (trigger) => {
      it.each(CASES)(
        '[SPEC:OSN-1][SPEC:OSN-2][SPEC:OSN-4][SPEC:OSN-6][SPEC:OSN-7] n=%i direction=%s',
        async (n, direction) => {
          const kinds = KINDS_OF[direction];
          const expected = n * kinds.length;
          const w = await buildOversizeWorld({ ...seedWorld(direction, n), incremental: syncPath === 'incremental' });
          const planSpy = jest.spyOn(
            w.engine as unknown as { executePlan: (...a: unknown[]) => Promise<void> }, 'executePlan',
          );

          await runTrigger(w, trigger);

          // The first sync builds a plan; the incremental path never does.
          if (syncPath === 'initial') expect(planSpy).toHaveBeenCalled();
          else expect(planSpy).not.toHaveBeenCalled();

          // Every trigger: no per-file notice, one log line per skipped path, one tally entry per skipped path.
          expect(perFileSizeNotices().length).toBe(0);
          expect(skipLogLines(w.logs).length).toBe(expected);
          expect(w.engine.getLastSessionSummary()?.oversizeSkippedPaths.size).toBe(expected);
          // Files within the limit still sync in the directions that were seeded.
          if (kinds.includes('upload')) {
            expect(w.client.uploadFile.mock.calls.map(c => c[0])).toContain('ok/up.md');
          }
          if (kinds.includes('download')) expect(w.vault.has('ok/down.md')).toBe(true);

          if (trigger === 'manual') {
            if (expected > 0) {
              const shown = skipNotices();
              expect(shown.length).toBe(1);
              expect(shown[0]?.message).toBe(oversizeSkipNoticeText(expected, LIMIT_MB));
              expect(shown[0]?.timeout).toBe(OVERSIZE_SKIP_NOTICE_MS);
              // Not visible yet when the result was shown: the count notice comes after setSyncComplete.
              expect(w.statusBar.skipNoticesAtComplete).toEqual([0]);
              expect(sessionLogLines(w.logs)).toEqual([sessionLine(expected, 'manual')]);
            } else {
              expect(skipNotices().length).toBe(0);
              expect(sessionLogLines(w.logs).length).toBe(0);
            }
          } else {
            expect(skipNotices().length).toBe(0);
            if (expected > 0) expect(sessionLogLines(w.logs)).toEqual([sessionLine(expected, 'automatic')]);
            else expect(sessionLogLines(w.logs).length).toBe(0);
          }
        },
        CASE_TIMEOUT_MS,
      );
    });
  });
});

describe('[SPEC:OSN-5] the skip count starts from zero on every sync', () => {
  const ORDERS: Array<[SessionTrigger, SessionTrigger]> = [
    ['automatic', 'manual'], ['manual', 'manual'], ['manual', 'automatic'],
  ];

  describe.each(PATHS)('%s sync', (syncPath) => {
    it.each(ORDERS)('[SPEC:OSN-5] %s sync, then %s sync: the second count ignores the first', async (first, second) => {
      const w = await buildOversizeWorld({
        local: [...numbered('up', 'a', 3, OVER), ['ok/up.md', UNDER]],
        incremental: syncPath === 'incremental',
      });

      await runSession(w, first);
      const firstSummary = w.engine.getLastSessionSummary();
      expect(firstSummary?.oversizeSkippedPaths.size).toBe(3);

      // Swap the three oversized files for two other oversized files and sync again.
      for (const [path] of numbered('up', 'a', 3, OVER)) w.vault.delete(path);
      for (const [path, body] of numbered('up', 'b', 2, OVER)) w.vault.set(path, { body, mtime: SEED_MTIME });
      await runSession(w, second);

      const secondSummary = w.engine.getLastSessionSummary();
      expect(secondSummary).not.toBe(firstSummary);
      expect(secondSummary?.oversizeSkippedPaths.size).toBe(2);
      expect([...(secondSummary?.oversizeSkippedPaths ?? [])].sort()).toEqual(['up/b-1.bin', 'up/b-2.bin']);

      // Only manual sessions show a count notice, and each shows its own session's count.
      const shown = skipNotices();
      expect(shown.length).toBe([first, second].filter(t => t === 'manual').length);
      if (first === 'manual') expect(shown[0]?.message).toBe(oversizeSkipNoticeText(3, LIMIT_MB));
      if (second === 'manual') expect(shown[shown.length - 1]?.message).toBe(oversizeSkipNoticeText(2, LIMIT_MB));
      expect(sessionLogLines(w.logs)).toEqual([sessionLine(3, first), sessionLine(2, second)]);
    });
  });
});

describe('[SPEC:OSN-8] a sync that fails after skips', () => {
  describe.each(PATHS)('%s sync', (syncPath) => {
    it.each(SESSION_TRIGGERS)('[SPEC:OSN-8] %s sync: the count notice follows "Sync failed", or is only logged', async (trigger) => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const w = await buildOversizeWorld({ local: numbered('up', 'o', 3, OVER), incremental: syncPath === 'incremental' });
      // Called after the files are processed (initial and incremental paths alike), so the three skips are already recorded.
      jest.spyOn(w.engine as unknown as { reconcileDirectories: () => Promise<void> }, 'reconcileDirectories')
        .mockRejectedValue(new Error('boom'));

      await runSession(w, trigger);

      const messages = notices().map(n => n.message);
      const failedAt = messages.indexOf('❌ Sync failed: boom');
      expect(failedAt).toBeGreaterThanOrEqual(0);
      expect(skipLogLines(w.logs).length).toBe(3);

      if (trigger === 'manual') {
        const shown = skipNotices();
        expect(shown.length).toBe(1);
        expect(shown[0]?.message).toBe(oversizeSkipNoticeText(3, LIMIT_MB));
        const skipAt = messages.findIndex(m => m.startsWith('⚠️ Skipped '));
        expect(failedAt).toBeLessThan(skipAt);
        // The count notice is the last thing the user sees.
        expect(messages[messages.length - 1]).toBe(shown[0]?.message);
      } else {
        expect(skipNotices().length).toBe(0);
      }
    });
  });
});

describe('[SPEC:OSN-10] a manual sync that did not start shows no count notice', () => {
  describe.each(PATHS)('%s sync', (syncPath) => {
    it('[SPEC:OSN-10] already running: the manual call returns at once and the running automatic sync only logs', async () => {
      const w = await buildOversizeWorld({ local: numbered('up', 'o', 3, OVER), incremental: syncPath === 'incremental' });
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      w.client.getFiles.mockImplementationOnce(async () => {
        await held;
        return w.listing();
      });
      try {
        const auto = w.automatic();
        await w.manual();
        expect(skipNotices().length).toBe(0);
        release();
        await auto;
        expect(skipNotices().length).toBe(0);
        expect(skipLogLines(w.logs).length).toBe(3);
      } finally {
        release();
      }
    });

    it('[SPEC:OSN-10] Wi-Fi only: the blocked manual sync records and shows nothing', async () => {
      const w = await buildOversizeWorld({ local: numbered('up', 'o', 3, OVER), incremental: syncPath === 'incremental' });
      jest.spyOn(w.engine as unknown as { isBlockedByWifiOnly: () => boolean }, 'isBlockedByWifiOnly')
        .mockReturnValue(true);

      await w.manual();

      expect(skipNotices().length).toBe(0);
      expect(skipLogLines(w.logs).length).toBe(0);
      expect(w.engine.getLastSessionSummary()).toBeNull();
    });
  });
});

describe('[SPEC:OSN-14] skips are not news for the quiet rule or the sync result', () => {
  describe.each(PATHS)('%s sync', (syncPath) => {
    it.each(SESSION_TRIGGERS)('[SPEC:OSN-14] %s sync: the result and status arguments match a world with no oversized file', async (trigger) => {
      const incremental = syncPath === 'incremental';
      const within: Pair[] = [['ok/up.md', UNDER]];
      const withinRemote: Pair[] = [['ok/down.md', UNDER]];
      // World A also holds oversized files in both directions; world B holds only the files within the limit.
      const a = await buildOversizeWorld({
        local: [...numbered('up', 'o', 2, OVER), ...within],
        remote: [...numbered('down', 'o', 2, OVER), ...withinRemote],
        incremental,
      });
      const b = await buildOversizeWorld({ local: within, remote: withinRemote, incremental });

      await runSession(a, trigger);
      await runSession(b, trigger);

      // Uploaded 1, downloaded 1, conflicts 0, errors 0: skipped files are not counted anywhere in the result.
      expect(b.statusBar.setSyncComplete.mock.calls).toEqual([[1, 1, 0, 0]]);
      expect(a.statusBar.setSyncComplete.mock.calls).toEqual(b.statusBar.setSyncComplete.mock.calls);
      expect(a.statusBar.setStatus.mock.calls).toEqual(b.statusBar.setStatus.mock.calls);
    });
  });
});

describe('[SPEC:OSN-13] community-plugin size notice coexists with the count notice', () => {
  const PLUGIN_NOTICE = '⚠️ Not syncing community plugins with a code file over the size limit: big.';
  const PLUGIN_NOTICE_MS = 8000;
  const SUPPRESSED_LOG = 'plugins: size-limit notice suppressed (automatic sync): big';
  const PLUGIN_DIR = '.obsidian/plugins/big';
  const PLUGIN_MANIFEST = '{"id":"big","name":"Big","version":"1.0.0"}';

  // The plugin "big" has a code file over the limit on the server; two ordinary files over the limit are local only.
  function pluginWorld(syncPath: SyncPath): ReturnType<typeof buildOversizeWorld> {
    return buildOversizeWorld({
      settings: { syncConfigFolder: true, syncedCommunityPlugins: ['big'] },
      local: numbered('up', 'o', 2, OVER),
      remote: [[`${PLUGIN_DIR}/manifest.json`, PLUGIN_MANIFEST], [`${PLUGIN_DIR}/main.js`, OVER]],
      incremental: syncPath === 'incremental',
    });
  }

  const pluginSizeNotices = (): Array<[string, number | undefined]> =>
    notices().filter(n => n.message.includes('over the size limit')).map((n): [string, number | undefined] => [n.message, n.timeout]);

  const suppressedLogs = (logs: string[]): string[] =>
    logs.filter(l => l.startsWith('plugins: size-limit notice suppressed'));

  describe.each(PATHS)('%s sync', (syncPath) => {
    it.each(SESSION_TRIGGERS)('[SPEC:OSN-13] %s sync: the plugin notice depends on the trigger and the count ignores the plugin files', async (trigger) => {
      const w = await pluginWorld(syncPath);

      await runSession(w, trigger);

      // The plugin was evaluated and ignored for its oversized code file in both triggers.
      expect(w.logs.filter(l => l.startsWith('plugins: included=[] ignored=[big:too-large]')).length).toBe(1);

      // The plugin files are not in the file count: only the two ordinary files are.
      const summary = w.engine.getLastSessionSummary();
      expect(summary).not.toBeNull();
      const skipped = [...(summary?.oversizeSkippedPaths ?? [])].sort();
      expect(skipped).toEqual(['up/o-1.bin', 'up/o-2.bin']);
      expect(skipped.filter(p => p.startsWith('.obsidian/'))).toEqual([]);
      expect(perFileSizeNotices().length).toBe(0);

      if (trigger === 'manual') {
        // Two separate notices: the plugin notice and the count notice.
        expect(pluginSizeNotices()).toEqual([[PLUGIN_NOTICE, PLUGIN_NOTICE_MS]]);
        const shown = skipNotices();
        expect(shown.length).toBe(1);
        expect(shown[0]?.message).toBe(oversizeSkipNoticeText(2, LIMIT_MB));
        expect(suppressedLogs(w.logs)).toEqual([]);
      } else {
        // An automatic sync shows neither notice; the plugin one is only logged, once.
        expect(pluginSizeNotices()).toEqual([]);
        expect(skipNotices().length).toBe(0);
        expect(suppressedLogs(w.logs)).toEqual([SUPPRESSED_LOG]);
      }
    });
  });
});
