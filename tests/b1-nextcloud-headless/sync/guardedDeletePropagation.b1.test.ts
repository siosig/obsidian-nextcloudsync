// Layer B (GitHub issue #46): full SyncEngine against a live Nextcloud. Trashing a folder locally took its children
// with it but left their StateDB rows, and a row saying "synced, now absent locally" is what the engine calls a user
// deletion, so the next sync deleted them on the server for real.
// The a-layer suites prove the decision; only a live server proves the trashed subtree stops being tracked when a real
// PROPFIND drives classification and that a genuine deletion still reaches the real trashbin.
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

  it('[SPEC:GDP-30]: a folder deleted on the server is trashed locally and leaves nothing that could be pushed back', async () => {
    const env = getEnv();
    const a = makeDevice(env, ws.remoteBase, 'deviceA-gdp30');
    // An unrelated note keeps the listing non-empty (the wholly-empty-listing case is EAD-*).
    a.vault.seedLocal('gdp30-keep.md', 'survivor');
    // Both levels of the new folder in ONE session: the uploads of GDP30/a.md and GDP30/sub/b.md run in parallel and both
    // MKCOL the shared ancestor. The MKCOL is single-flight, so seeding both at once is the live proof.
    a.vault.seedLocal('GDP30/a.md', 'alpha');
    a.vault.seedLocal('GDP30/sub/b.md', 'beta');
    await a.sync();
    // Both files landing on the server is the proof: a lost MKCOL race left the PUT 404ing.
    expect((await baseClient.getFiles('')).map((f) => f.path))
      .toEqual(expect.arrayContaining(['GDP30/a.md', 'GDP30/sub/b.md']));

    await baseClient.deleteCollection('GDP30');

    const deleteFile = jest.spyOn(a.client, 'deleteFile');
    await a.sync();

    expect(a.vault.localExists('GDP30/a.md')).toBe(false);
    expect(a.vault.folderExists('GDP30')).toBe(false);

    // Nothing under the folder is still tracked: a surviving row would become a server-side DELETE on the next sync.
    expect(a.stateDB.getFile('GDP30/a.md')).toBeUndefined();
    expect(a.stateDB.getFile('GDP30/sub/b.md')).toBeUndefined();
    expect(a.stateDB.getDir('GDP30')).toBeUndefined();
    expect(a.stateDB.getDir('GDP30/sub')).toBeUndefined();

    await a.sync();
    expect(deleteFile).not.toHaveBeenCalled();
    expect(a.engine.getLastSessionSummary()?.deletedCount).toBe(0);
    deleteFile.mockRestore();
  });

  it('[SPEC:GDP-31]: a folder the user deletes locally is still propagated to the server', async () => {
    const env = getEnv();
    const a = makeDevice(env, ws.remoteBase, 'deviceA-gdp31');
    a.vault.seedLocal('gdp31-keep.md', 'survivor');
    a.vault.seedLocal('GDP31/a.md', 'alpha');
    await a.sync();
    expect((await baseClient.getFiles('')).map((f) => f.path)).toContain('GDP31/a.md');

    a.vault.deleteLocalTree('GDP31');
    await a.sync();

    expect((await baseClient.getFiles('')).map((f) => f.path)).not.toContain('GDP31/a.md');
    expect(await baseClient.remoteExists('GDP31')).toBe(false);
    expect(a.stateDB.getFile('GDP31/a.md')).toBeUndefined();
  });

  it('[SPEC:GDP-32]: deleting locally a note another device just edited restores it instead of destroying it', async () => {
    const env = getEnv();
    const a = makeDevice(env, ws.remoteBase, 'deviceA-gdp32');
    const b = makeDevice(env, ws.remoteBase, 'deviceB-gdp32');
    a.vault.seedLocal('gdp32-note.md', 'shared base\n');
    await a.sync();
    await b.sync();
    expect(b.vault.localExists('gdp32-note.md')).toBe(true);

    b.vault.seedLocal('gdp32-note.md', 'shared base\nB added a line\n');
    await b.sync();

    // A deletes its stale copy; the server's copy is not what A last synced, so the deletion is not provably A's intent and
    // restoring is the only non-destructive answer.
    a.vault.deleteLocalTree('gdp32-note.md'); // a single path: the same removal a file delete makes
    await a.sync();

    expect((await baseClient.getFiles('')).map((f) => f.path)).toContain('gdp32-note.md');
    expect(a.vault.readLocal('gdp32-note.md')).toContain('B added a line');
  });
});
