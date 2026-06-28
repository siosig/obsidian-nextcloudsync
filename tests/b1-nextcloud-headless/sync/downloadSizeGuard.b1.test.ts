// Layer B — download-side size guard end-to-end (spec 035, issue #8) against a live Nextcloud
// (localhost Docker). The layer-A test (downloadSizeGuard.test.ts) drives the guard with a mocked
// RemoteFileInfo.size; this proves the guard fires on the REAL size the server advertises in
// PROPFIND (getcontentlength) — the source of truth that mocks cannot exercise. Device A (unlimited)
// uploads an over-limit note; device B, with a small Maximum file size, skips the GET, leaving no
// local file and recording no error; then it self-heals and downloads the note once the cap is lifted.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice } from '../support/engineDevice';

describeLive('Layer B — download size guard end-to-end (DSG)', (getEnv) => {
  let ws: IsolatedWorkspace;
  let baseClient: NextcloudClient;

  beforeAll(async () => {
    const s = await setupWorkspace(getEnv());
    ws = s.ws;
    baseClient = s.client;
  });

  afterAll(async () => {
    if (baseClient && ws) await cleanupWorkspace(baseClient, ws);
  });

  it('DSG-e2e: device B skips an over-limit note (real PROPFIND size), records no error, then self-heals', async () => {
    const env = getEnv();
    // A 3 MB note: over device B's 2 MB cap, under device A's unlimited cap. 'x' is one byte in UTF-8
    // so the on-server getcontentlength is exactly the string length (deterministic boundary).
    const big = 'x'.repeat(3 * 1024 * 1024);

    // Device A (Maximum file size = 0 → unlimited) uploads the big note plus a small survivor note
    // (keeps the remote listing non-empty so the absence-deletion safety guard never interferes).
    const a = makeDevice(env, ws.remoteBase, 'deviceA-dsg', { maxFileSizeMB: 0 });
    a.vault.seedLocal('keep.md', 'survivor');
    a.vault.seedLocal('big.md', big);
    await a.sync();

    expect((await baseClient.getFiles('')).map((f) => f.path))
      .toEqual(expect.arrayContaining(['keep.md', 'big.md']));

    // Device B (Maximum file size = 2 MB) syncs: the small note downloads, the big note is skipped
    // BEFORE the GET using the size the server advertised. The skip leaves local + Base untouched —
    // no local file is written and NO StateDB entry is recorded for the big note (a clean, non-error
    // deferral, not a partial/conflicted write), while the small note tracks normally.
    const b = makeDevice(env, ws.remoteBase, 'deviceB-dsg', { maxFileSizeMB: 2 });
    await b.sync();
    expect(b.vault.localExists('keep.md')).toBe(true);
    expect(b.vault.localExists('big.md')).toBe(false);
    expect(b.stateDB.getFile('keep.md')).toBeDefined();
    expect(b.stateDB.getFile('big.md')).toBeUndefined();

    // Self-healing (DSG-8): lifting the cap and re-syncing downloads the note intact — the skip was a
    // non-destructive, recoverable deferral, not a permanent loss. settings is the same object the
    // engine reads, so mutating it here is exactly what raising the cap in the UI does.
    b.settings.maxFileSizeMB = 0;
    await b.sync();
    expect(b.vault.localExists('big.md')).toBe(true);
    expect(b.vault.readLocal('big.md')).toBe(big);
  });
});
