// Single-file resolution operations (Compare, manual pull, push, force resolution) keep their own notice or
// error for an over-the-limit file and take no part in the size-limit skip tally (docs/spec.md §9.4a): they are
// never counted, never followed by the count notice, never logged as a skip, and never create a session summary.
// Each test runs the operation on a real SyncEngine over the shared fake vault and server.
import {
  buildOversizeWorld, notices, skipNotices, skipLogLines, OVER, UNDER, OversizeWorld,
} from '../../support/oversizeWorld';

const PATH = 'big.bin';
const PREVIEW_PREFIX = `⚠️ File too large to preview: ${PATH}`;
const UPLOAD_SKIPPED = `Upload skipped (over the size limit): ${PATH}`;

// None of these operations is a sync session: no summary exists, no skip line is logged, no count notice appears.
function expectNotCounted(w: OversizeWorld): void {
  expect(w.engine.getLastSessionSummary()).toBeNull();
  expect(skipLogLines(w.logs)).toHaveLength(0);
  expect(skipNotices()).toHaveLength(0);
}

describe('[SPEC:OSN-15] single-file resolution operations stay outside the skip tally', () => {
  it('[SPEC:OSN-15] Compare of an oversized remote shows its own single preview notice and is not counted', async () => {
    const w = await buildOversizeWorld({ local: [[PATH, UNDER]], remote: [[PATH, OVER]] });
    notices().length = 0;

    await w.engine.compareWithRemote(PATH);

    expect(notices()).toHaveLength(1);
    expect(notices()[0].message.slice(0, PREVIEW_PREFIX.length)).toBe(PREVIEW_PREFIX);
    expectNotCounted(w);
  });

  it('[SPEC:OSN-15] manual pull of an oversized remote rejects with its own error and shows no notice', async () => {
    const w = await buildOversizeWorld({ local: [[PATH, UNDER]], remote: [[PATH, OVER]] });
    notices().length = 0;

    await expect(w.engine.pullRemoteToLocal(PATH)).rejects.toThrow(/File too large to download/);

    expect(notices()).toHaveLength(0);
    expectNotCounted(w);
  });

  it('[SPEC:OSN-15] push of an oversized local file rejects with the upload-skipped error and shows no notice', async () => {
    const w = await buildOversizeWorld({ local: [[PATH, OVER]] });
    notices().length = 0;

    await expect(w.engine.pushLocalToRemote(PATH)).rejects.toThrow(UPLOAD_SKIPPED);

    expect(notices()).toHaveLength(0);
    expectNotCounted(w);
  });

  // With no clean-side record the force resolution falls back to a plain push (docs/spec.md §8), so it ends in
  // the same upload-skipped error.
  it('[SPEC:OSN-15] force resolution of an oversized local file rejects with the upload-skipped error and shows no notice', async () => {
    const w = await buildOversizeWorld({ local: [[PATH, OVER]] });
    notices().length = 0;

    await expect(w.engine.applyCleanLocal(PATH)).rejects.toThrow(UPLOAD_SKIPPED);

    expect(notices()).toHaveLength(0);
    expectNotCounted(w);
  });
});
