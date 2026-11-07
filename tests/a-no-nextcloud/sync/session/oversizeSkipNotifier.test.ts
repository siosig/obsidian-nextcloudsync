// Direct tests for the skip-count notice (docs/spec.md §9.4a): the exact text, and the one place that
// turns a session's skip tally into a notice. The notice goes out through an injected `notify`, so no
// Obsidian Notice mock is involved here; the engine-level wiring is covered by the engine suites.
import {
  OversizeSkipNotifier, oversizeSkipNoticeText, OVERSIZE_SKIP_NOTICE_MS,
} from '../../../../src/sync/session/OversizeSkipNotifier';
import type { SyncSessionSummary, SyncTrigger } from '../../../../src/types';
import { makeSummary } from '../../support/engineHarness';

const TRIGGERS: SyncTrigger[] = ['manual', 'automatic'];
const THREE_PATHS = ['secret/a.bin', 'b.bin', 'dir/sub/c.bin'];

function summaryOf(paths: string[]): SyncSessionSummary {
  return { ...makeSummary(), oversizeSkippedPaths: new Set(paths) };
}

interface LoggedLine { m: string; level?: string }

function setup(initialLimitMB = 20) {
  const limit = { mb: initialLimitMB };
  const notify = jest.fn<void, [string, number]>();
  const logged: LoggedLine[] = [];
  const logger = { log: jest.fn(async (m: string, level?: string) => { logged.push({ m, level }); }) };
  const notifier = new OversizeSkipNotifier({ maxFileSizeMB: () => limit.mb, notify, logger });
  return { limit, notify, logged, logger, notifier };
}

// A rejected log promise nobody handles is reported by jest as a failure of the running test, but only
// once the microtask queue has drained; a macrotask turn makes sure it has.
const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

describe('[SPEC:OSN-3] oversizeSkipNoticeText', () => {
  it('[SPEC:OSN-3] uses the singular for one file', () => {
    expect(oversizeSkipNoticeText(1, 20)).toBe(
      '⚠️ Skipped 1 file over the 20 MB size limit. Raise "Maximum file size (MB)" and sync again to include it.',
    );
  });

  it('[SPEC:OSN-3] uses the plural and prints the count without a separator', () => {
    expect(oversizeSkipNoticeText(1000, 20)).toBe(
      '⚠️ Skipped 1000 files over the 20 MB size limit. Raise "Maximum file size (MB)" and sync again to include them.',
    );
  });

  it('[SPEC:OSN-3] prints a fractional limit as is', () => {
    expect(oversizeSkipNoticeText(3, 0.001)).toBe(
      '⚠️ Skipped 3 files over the 0.001 MB size limit. Raise "Maximum file size (MB)" and sync again to include them.',
    );
  });

  it('[SPEC:OSN-3] drops the limit and the setting hint when the limit is 0', () => {
    expect(oversizeSkipNoticeText(1, 0)).toBe('⚠️ Skipped 1 file over the size limit. Sync again to include it.');
  });

  it('[SPEC:OSN-3] drops the limit and the setting hint when the limit is negative', () => {
    expect(oversizeSkipNoticeText(2, -1)).toBe('⚠️ Skipped 2 files over the size limit. Sync again to include them.');
  });

  it('[SPEC:OSN-3] shows the notice for 8000 ms', () => {
    expect(OVERSIZE_SKIP_NOTICE_MS).toBe(8000);
  });

  it('[SPEC:OSN-3] never puts a skipped path into the text handed to notify', () => {
    const { notify, notifier } = setup();
    notifier.sessionFinished(summaryOf(THREE_PATHS), 'manual');
    expect(notify).toHaveBeenCalledTimes(1);
    const body = notify.mock.calls[0][0];
    for (const path of THREE_PATHS) expect(body).not.toContain(path);
    expect(body).not.toContain('.bin');
  });
});

describe('[SPEC:OSN-2] OversizeSkipNotifier.sessionFinished', () => {
  it.each(TRIGGERS)('[SPEC:OSN-2] does nothing and logs nothing for zero skips (%s)', (trigger) => {
    const { notify, logged, logger, notifier } = setup();
    notifier.sessionFinished(summaryOf([]), trigger);
    expect(notify).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it('[SPEC:OSN-2] shows exactly one count notice after a manual session and logs it as shown', () => {
    const { notify, logged, notifier } = setup(20);
    notifier.sessionFinished(summaryOf(THREE_PATHS), 'manual');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(oversizeSkipNoticeText(3, 20), 8000);
    expect(logged.map((l) => l.m)).toEqual(['size-limit: session total=3 trigger=manual notice=shown']);
  });

  it('[SPEC:OSN-2] shows no notice after an automatic session and logs it as suppressed', () => {
    const { notify, logged, notifier } = setup(20);
    notifier.sessionFinished(summaryOf(THREE_PATHS), 'automatic');
    expect(notify).not.toHaveBeenCalled();
    expect(logged.map((l) => l.m)).toEqual(['size-limit: session total=3 trigger=automatic notice=suppressed']);
  });

  it('[SPEC:OSN-2] counts distinct skipped paths, not skip events', () => {
    const { notify, logged, notifier } = setup(20);
    notifier.sessionFinished(summaryOf(['a.bin', 'a.bin', 'b.bin']), 'manual');
    expect(notify).toHaveBeenCalledWith(oversizeSkipNoticeText(2, 20), 8000);
    expect(logged.map((l) => l.m)).toEqual(['size-limit: session total=2 trigger=manual notice=shown']);
  });

  it('[SPEC:OSN-2] reads the limit when the session finishes, not when the skips were recorded', () => {
    const { limit, notify, notifier } = setup(20);
    const summary = summaryOf(THREE_PATHS);
    limit.mb = 50;
    notifier.sessionFinished(summary, 'manual');
    expect(notify).toHaveBeenCalledTimes(1);
    const body = notify.mock.calls[0][0];
    expect(body).toContain('50 MB');
    expect(body).not.toContain('20 MB');
    expect(body).toBe(oversizeSkipNoticeText(3, 50));
  });

  it('[SPEC:OSN-2] keeps no state between sessions', () => {
    const { notify, notifier } = setup(20);
    notifier.sessionFinished(summaryOf(['a.bin']), 'manual');
    notifier.sessionFinished(summaryOf(THREE_PATHS), 'manual');
    notifier.sessionFinished(summaryOf([]), 'manual');
    expect(notify.mock.calls).toEqual([
      [oversizeSkipNoticeText(1, 20), 8000],
      [oversizeSkipNoticeText(3, 20), 8000],
    ]);
  });

  it('[SPEC:OSN-2] survives a notify that throws, logs it at error level, and still logs the session line', () => {
    const { notify, logged, notifier } = setup(20);
    notify.mockImplementation(() => { throw new Error('boom'); });
    expect(() => notifier.sessionFinished(summaryOf(THREE_PATHS), 'manual')).not.toThrow();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logged.map((l) => l.m)).toEqual([
      'size-limit: notice failed — boom',
      'size-limit: session total=3 trigger=manual notice=shown',
    ]);
    expect(logged[0].level).toBe('error');
  });

  it('[SPEC:OSN-2] does not let a logger that throws synchronously escape', () => {
    const notify = jest.fn<void, [string, number]>();
    const log = jest.fn((): Promise<void> => { throw new Error('log boom'); });
    const notifier = new OversizeSkipNotifier({ maxFileSizeMB: () => 20, notify, logger: { log } });
    for (const trigger of TRIGGERS) {
      expect(() => notifier.sessionFinished(summaryOf(THREE_PATHS), trigger)).not.toThrow();
    }
    expect(notify).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
  });

  it('[SPEC:OSN-2] does not let a logger that rejects escape', async () => {
    const notify = jest.fn<void, [string, number]>();
    const log = jest.fn(async (): Promise<void> => { throw new Error('log reject'); });
    const notifier = new OversizeSkipNotifier({ maxFileSizeMB: () => 20, notify, logger: { log } });
    for (const trigger of TRIGGERS) {
      expect(() => notifier.sessionFinished(summaryOf(THREE_PATHS), trigger)).not.toThrow();
    }
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
  });

  it('[SPEC:OSN-2] survives a notify that throws together with a logger that throws', async () => {
    const notify = jest.fn<void, [string, number]>(() => { throw new Error('boom'); });
    const log = jest.fn((): Promise<void> => { throw new Error('log boom'); });
    const notifier = new OversizeSkipNotifier({ maxFileSizeMB: () => 20, notify, logger: { log } });
    expect(() => notifier.sessionFinished(summaryOf(THREE_PATHS), 'manual')).not.toThrow();
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('[SPEC:OSN-2] works without a logger', () => {
    const notify = jest.fn<void, [string, number]>();
    const notifier = new OversizeSkipNotifier({ maxFileSizeMB: () => 20, notify });
    expect(() => notifier.sessionFinished(summaryOf(THREE_PATHS), 'manual')).not.toThrow();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(oversizeSkipNoticeText(3, 20), 8000);
    expect(() => notifier.sessionFinished(summaryOf(THREE_PATHS), 'automatic')).not.toThrow();
    expect(() => notifier.sessionFinished(summaryOf([]), 'manual')).not.toThrow();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('[SPEC:OSN-2] works without a logger when notify throws', () => {
    const notify = jest.fn<void, [string, number]>(() => { throw new Error('boom'); });
    const notifier = new OversizeSkipNotifier({ maxFileSizeMB: () => 20, notify });
    expect(() => notifier.sessionFinished(summaryOf(THREE_PATHS), 'manual')).not.toThrow();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
