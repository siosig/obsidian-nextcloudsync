// Layer B — feature 086 (GitHub issue #46), full SyncEngine against a live Nextcloud.
//
// The report was that files vanished from BOTH sides: the folder went to the local `.trash`, and its
// contents turned up in Nextcloud's own trashbin. Only the first half was ever deliberate. Trashing
// a folder took its children with it but left their StateDB rows behind, and a row saying "synced,
// now absent locally" is what this engine calls a user deletion — so the next sync pushed it to the
// server for real.
//
// The a-layer suites prove the decision. What they cannot prove is that the decision survives a real
// server: whether the trashed subtree really stops being tracked when a real PROPFIND drives the
// classification, and whether a genuine deletion still reaches a real trashbin afterwards. Both
// halves matter — removing a false positive is only worth anything if it does not create a false
// negative in its place.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice } from '../support/engineDevice';

describeLive('Layer B — guarded delete propagation (feature 086 / issue #46)', (getEnv) => {
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

  it('GDP-30: a folder deleted on the server is trashed locally and leaves nothing that could be pushed back', async () => {
    const env = getEnv();
    const a = makeDevice(env, ws.remoteBase, 'deviceA-gdp30');
    // An unrelated note keeps the listing non-empty, so this exercises the ordinary shape of the bug
    // rather than the wholly-empty-listing case (that one is EAD-*/feature 083).
    a.vault.seedLocal('gdp30-keep.md', 'survivor');
    a.vault.seedLocal('GDP30/a.md', 'alpha');
    await a.sync();
    // One new folder level per session, on purpose. Seeding `GDP30/a.md` and `GDP30/sub/b.md` at once
    // makes two uploads race for the same missing parent, and the reactive MKCOL recovery loses that
    // race often enough to see — both PUTs come back 404 and land as session errors. That is a known,
    // separate defect (INV-12, the nested-upload 404 recovery), and this test is about deletion, so it
    // sidesteps the race instead of inheriting its flakiness.
    a.vault.seedLocal('GDP30/sub/b.md', 'beta');
    await a.sync();
    expect((await baseClient.getFiles('')).map((f) => f.path))
      .toEqual(expect.arrayContaining(['GDP30/a.md', 'GDP30/sub/b.md']));

    // Someone removes the folder on the server (another device, the web UI — it does not matter).
    await baseClient.deleteCollection('GDP30');

    const deleteFile = jest.spyOn(a.client, 'deleteFile');
    await a.sync();

    // Applied locally, as before.
    expect(a.vault.localExists('GDP30/a.md')).toBe(false);
    expect(a.vault.folderExists('GDP30')).toBe(false);

    // And — the fix — nothing under it is still tracked. A surviving row here is precisely what used
    // to become a server-side DELETE on the following sync.
    expect(a.stateDB.getFile('GDP30/a.md')).toBeUndefined();
    expect(a.stateDB.getFile('GDP30/sub/b.md')).toBeUndefined();
    expect(a.stateDB.getDir('GDP30')).toBeUndefined();
    expect(a.stateDB.getDir('GDP30/sub')).toBeUndefined();

    // The following sync has nothing to say about the folder at all.
    await a.sync();
    expect(deleteFile).not.toHaveBeenCalled();
    expect(a.engine.getLastSessionSummary()?.deletedCount).toBe(0);
    deleteFile.mockRestore();
  });

  it('GDP-31: a folder the user deletes locally is still propagated to the server', async () => {
    const env = getEnv();
    const a = makeDevice(env, ws.remoteBase, 'deviceA-gdp31');
    a.vault.seedLocal('gdp31-keep.md', 'survivor');
    a.vault.seedLocal('GDP31/a.md', 'alpha');
    await a.sync();
    expect((await baseClient.getFiles('')).map((f) => f.path)).toContain('GDP31/a.md');

    a.vault.deleteLocalTree('GDP31');
    await a.sync();

    // The whole point of demanding proof is that it must not cost us the real deletions.
    expect((await baseClient.getFiles('')).map((f) => f.path)).not.toContain('GDP31/a.md');
    expect(await baseClient.remoteExists('GDP31')).toBe(false);
    expect(a.stateDB.getFile('GDP31/a.md')).toBeUndefined();
  });

  it('GDP-32: deleting locally a note another device just edited restores it instead of destroying it', async () => {
    const env = getEnv();
    const a = makeDevice(env, ws.remoteBase, 'deviceA-gdp32');
    const b = makeDevice(env, ws.remoteBase, 'deviceB-gdp32');
    a.vault.seedLocal('gdp32-note.md', 'shared base\n');
    await a.sync();
    await b.sync();
    expect(b.vault.localExists('gdp32-note.md')).toBe(true);

    // B edits and publishes. A has not seen it yet, so A's base is the old body.
    b.vault.seedLocal('gdp32-note.md', 'shared base\nB added a line\n');
    await b.sync();

    // A deletes its stale copy. The server's copy is NOT what A last synced, so the deletion is not
    // provably A's intent for the current content — restoring is the only non-destructive answer.
    a.vault.deleteLocalTree('gdp32-note.md'); // a single path: the same removal a file delete makes
    await a.sync();

    expect((await baseClient.getFiles('')).map((f) => f.path)).toContain('gdp32-note.md');
    expect(a.vault.readLocal('gdp32-note.md')).toContain('B added a line');
  });
});
