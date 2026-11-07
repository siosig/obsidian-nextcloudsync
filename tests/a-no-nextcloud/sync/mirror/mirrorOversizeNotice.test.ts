// Mirror from remote and the size-limit skip notice (docs/spec.md §9.4a, §14).
//
// Mirror is always a manual run: when it skipped files over the size limit it shows ONE count notice after
// the result, none when it stops at the planning stage (nothing was transferred), and one before the error is
// rethrown when applying the plan fails. The world holds no local-only file, so nothing is deleted and the
// only thing under test is the notice. The remote has two over-the-limit files and one file within the limit.
import {
  buildOversizeWorld, LIMIT_MB, OVER, UNDER, notices, skipNotices, perFileSizeNotices, sessionLogLines,
} from '../../support/oversizeWorld';
import { oversizeSkipNoticeText } from '../../../../src/sync/session/OversizeSkipNotifier';

const REMOTE_WITH_OVER: Array<[string, string]> = [
  ['down/o-1.bin', OVER],
  ['down/o-2.bin', OVER],
  ['ok/down.md', UNDER],
];

beforeEach(() => {
  (globalThis as { navigator?: unknown }).navigator ??= {};
  notices().length = 0;
});
afterEach(() => { jest.restoreAllMocks(); });

describe('[SPEC:OSN-11][SPEC:OSN-1] Mirror from remote shows one count notice for the files it skipped', () => {
  it('[SPEC:OSN-11][SPEC:OSN-1] shows one notice after the result and no per-file notice', async () => {
    const w = await buildOversizeWorld({ remote: REMOTE_WITH_OVER });

    const plan = await w.engine.planRemoteMirror();
    expect(plan.ok).toBe(true);
    await w.engine.applyRemoteMirror(plan);

    expect(perFileSizeNotices()).toHaveLength(0);
    expect(skipNotices().map(n => [n.message, n.timeout])).toEqual([
      [oversizeSkipNoticeText(2, LIMIT_MB), 8000],
    ]);
    // The notice follows the result: it was not visible yet when the result was shown.
    expect(w.statusBar.skipNoticesAtComplete).toEqual([0]);
    expect(w.vault.has('ok/down.md')).toBe(true);
    expect(w.vault.has('down/o-1.bin')).toBe(false);
    expect(w.vault.has('down/o-2.bin')).toBe(false);
    expect(sessionLogLines(w.logs)).toEqual(['size-limit: session total=2 trigger=manual notice=shown']);
  });

  it('[SPEC:OSN-11] shows no notice when the plan could not be built', async () => {
    const w = await buildOversizeWorld({ remote: REMOTE_WITH_OVER });
    w.client.getFiles.mockRejectedValueOnce(new Error('offline'));

    const plan = await w.engine.planRemoteMirror();
    expect(plan.ok).toBe(false);
    await w.engine.applyRemoteMirror(plan);

    expect(skipNotices()).toHaveLength(0);
    expect(perFileSizeNotices()).toHaveLength(0);
    expect(sessionLogLines(w.logs)).toEqual([]);
    expect(w.vault.has('ok/down.md')).toBe(false);
  });

  it('[SPEC:OSN-11] shows the notice before the error is rethrown when applying the plan throws', async () => {
    const w = await buildOversizeWorld({ remote: REMOTE_WITH_OVER });
    const plan = await w.engine.planRemoteMirror();
    expect(plan.ok).toBe(true);
    jest.spyOn(w.stateDB, 'setRemoteRootEtag').mockImplementation(() => { throw new Error('boom'); });

    await expect(w.engine.applyRemoteMirror(plan)).rejects.toThrow('boom');

    expect(skipNotices().map(n => [n.message, n.timeout])).toEqual([
      [oversizeSkipNoticeText(2, LIMIT_MB), 8000],
    ]);
    expect(perFileSizeNotices()).toHaveLength(0);
    expect(sessionLogLines(w.logs)).toEqual(['size-limit: session total=2 trigger=manual notice=shown']);
  });

  it('[SPEC:OSN-11] shows no notice when no remote file is over the limit', async () => {
    const w = await buildOversizeWorld({ remote: [['ok/down.md', UNDER]] });

    const plan = await w.engine.planRemoteMirror();
    expect(plan.ok).toBe(true);
    await w.engine.applyRemoteMirror(plan);

    expect(skipNotices()).toHaveLength(0);
    expect(perFileSizeNotices()).toHaveLength(0);
    expect(w.vault.has('ok/down.md')).toBe(true);
    expect(sessionLogLines(w.logs)).toEqual([]);
  });
});
