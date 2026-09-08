// Layer B — the two states a shared workspace can never reproduce: a vault whose remote listing is
// EMPTY, and a vault whose remote FOLDER is gone (feature 083 / GitHub issue #50).
//
// Both need a remote that holds nothing but this test's own files, so this file takes its own
// isolated workspace instead of joining syncInvariants.b1.test.ts — every test there accumulates
// files in one shared folder, and INV-4's `anchor.md` exists precisely to keep the listing non-empty.
//
// What is being proved:
//   INV-13 — deleting the LAST tracked file on one device reaches the other. Before 083 the empty
//            listing was skipped wholesale, so the file stayed on disk and in State, and the next
//            sync's root-ETag short-circuit rebuilt it from State as "still on the server" — the
//            vault never converged on its own.
//   INV-14 — deleting the vault FOLDER on the server is repaired, not obeyed. The folder comes back
//            and the vault is re-uploaded from local; nothing is trashed locally.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice, Device } from '../support/engineDevice';
import { DavSyncSettings, RemoteRootMissingError } from '../../../src/types';

describeLive('Layer B — empty listing and a missing vault folder', (getEnv) => {
  let ws: IsolatedWorkspace;
  let baseClient: NextcloudClient;

  beforeAll(async () => {
    const s = await setupWorkspace(getEnv());
    ws = s.ws;
    baseClient = s.client;
  });
  afterAll(async () => { if (baseClient && ws) await cleanupWorkspace(baseClient, ws); });

  const remoteExists = (p: string): Promise<boolean> => baseClient.remoteExists(p);
  const dev = (id: string, over: Partial<DavSyncSettings> = {}): Device => makeDevice(getEnv(), ws.remoteBase, id, over);

  it('INV-13 [SPEC:EAD-B1-1] the last tracked file, deleted elsewhere, is deleted locally and does not come back', async () => {
    const d = dev('inv13-D'); const m = dev('inv13-M');
    // No anchor file on purpose: after the delete, M's full scan sees a listing with zero entries —
    // the exact state the reporter hit with a one-note vault.
    d.vault.seedLocal('only.md', 'only\n');
    await d.sync(); await m.sync();
    expect(m.vault.localExists('only.md')).toBe(true);

    d.vault.deleteLocalTree('only.md'); await d.sync();
    expect(await remoteExists('only.md')).toBe(false);

    await m.sync();
    expect(m.vault.localExists('only.md')).toBe(false);       // absence + 404 re-check → trashed
    expect(m.stateDB.getFile('only.md')).toBeUndefined();      // and untracked, so nothing can rebuild it

    // The convergence half of the bug: a second sync must not resurrect it from State.
    await m.sync();
    expect(m.vault.localExists('only.md')).toBe(false);
  }, 180_000);

  it('INV-14 [SPEC:VRR-B1-1] a vault folder deleted on the server is re-created and re-seeded from local', async () => {
    const d = dev('inv14-D');
    d.vault.seedLocal('a.md', 'alpha\n');
    d.vault.seedLocal('sub/b.md', 'bravo\n');
    d.vault.seedFolder('empty');                               // empty folders are first-class (DP)
    await d.sync();
    expect(await remoteExists('sub/b.md')).toBe(true);
    expect(await remoteExists('empty')).toBe(true);   // baseline: the empty dir does reach the server

    // Someone removes the whole vault folder on the server. deleteFile('', '') targets the workspace
    // itself because the client is constructed with it as its remoteBase.
    await baseClient.deleteFile('', '');
    await expect(baseClient.getFiles('')).rejects.toThrow(RemoteRootMissingError);

    await d.sync();

    // Restored on the server: files, the subfolder, and the deliberately empty folder.
    expect(await remoteExists('a.md')).toBe(true);
    expect(await remoteExists('sub/b.md')).toBe(true);
    expect(await remoteExists('empty')).toBe(true);
    // Untouched locally — a missing folder is never read as "everything was deleted".
    expect(d.vault.localExists('a.md')).toBe(true);
    expect(d.vault.readLocal('sub/b.md')).toBe('bravo\n');

    // And it converges: the re-seed leaves State agreeing with the remote, so the next sync is a no-op.
    await d.sync();
    expect(await remoteExists('a.md')).toBe(true);
    expect(d.vault.localExists('a.md')).toBe(true);
  }, 240_000);
});
