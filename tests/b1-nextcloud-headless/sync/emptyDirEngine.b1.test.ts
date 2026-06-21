// Layer B — full SyncEngine, end to end, against a live Nextcloud (localhost Docker).
// Reproduces the reported bug at the engine level and proves the fix: a folder emptied on one
// device is pruned from the remote AND from the other device on its next sync.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice } from '../support/engineDevice';

describeLive('Layer B — empty-dir pruning end-to-end (engine)', (getEnv) => {
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

  it('DP-e2e: a folder emptied on device A is pruned on the remote and on device B', async () => {
    const env = getEnv();

    // Device A creates a folder of notes (plus an unrelated note that survives the whole test, so
    // the remote listing is never empty — mirroring a real vault and keeping the absence-deletion
    // safety guard, which refuses to act on a wholly-empty listing, from suppressing the deletions).
    const a = makeDevice(env, ws.remoteBase, 'deviceA-ed1');
    a.vault.seedLocal('keep.md', 'survivor');
    a.vault.seedLocal('2011/a.md', 'alpha');
    a.vault.seedLocal('2011/b.md', 'beta');
    await a.sync();

    expect((await baseClient.getFiles('')).map((f) => f.path))
      .toEqual(expect.arrayContaining(['2011/a.md', '2011/b.md']));

    // Device B picks them up.
    const b = makeDevice(env, ws.remoteBase, 'deviceB-ed1');
    await b.sync();
    expect(b.vault.localExists('2011/a.md')).toBe(true);
    expect(b.vault.folderExists('2011')).toBe(true);

    // The user deletes the whole 2011 folder on A, then syncs.
    a.vault.deleteLocalTree('2011');
    await a.sync();

    // Remote: the files are gone AND the now-empty directory is pruned (the bug was that it lingered).
    expect((await baseClient.getFiles('')).map((f) => f.path)).not.toContain('2011/a.md');
    expect(await baseClient.remoteExists('2011')).toBe(false);

    // Device B syncs: it applies the deletions and prunes its now-empty local folder too.
    await b.sync();
    expect(b.vault.localExists('2011/a.md')).toBe(false);
    expect(b.vault.folderExists('2011')).toBe(false);
  });

  it('DP-e2e-empty: an EMPTY directory created on device A is propagated to the remote and device B', async () => {
    const env = getEnv();

    // Device A creates an empty folder (no files) plus an unrelated note, then syncs.
    const a = makeDevice(env, ws.remoteBase, 'deviceA-ed2');
    a.vault.seedLocal('anchor.md', 'anchor');
    a.vault.seedFolder('empties/keepme'); // a deliberately empty directory
    await a.sync();

    // The empty directory exists on the remote (it was NOT discarded for holding no files).
    expect(await baseClient.remoteExists('empties/keepme')).toBe(true);

    // Device B picks up the empty directory.
    const b = makeDevice(env, ws.remoteBase, 'deviceB-ed2');
    await b.sync();
    expect(b.vault.folderExists('empties/keepme')).toBe(true);
  });
});
