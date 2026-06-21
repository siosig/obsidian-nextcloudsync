// Layer B — directory rename propagation end-to-end (engine).
// Verifies that renaming a folder locally is reflected on the remote (files MOVEd, old dir pruned,
// new dir tracked) and that concurrent rename vs create on a same-name target converges without
// data loss (union of both sides).
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice } from '../support/engineDevice';

describeLive('Layer B — directory rename propagation (engine)', (getEnv) => {
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

  it('DR-local: renaming a folder locally MOVEs its files on the remote, prunes the old dir, and device B picks up the new name', async () => {
    const env = getEnv();

    // Device A creates old/note.md plus an anchor file, then syncs.
    const a = makeDevice(env, ws.remoteBase, 'deviceA-dr1');
    a.vault.seedLocal('anchor.md', 'anchor');
    a.vault.seedLocal('old/note.md', 'hello from old');
    await a.sync();

    expect(await baseClient.remoteExists('old/note.md')).toBe(true);

    // A renames old → new by seeding the file under the new name and deleting the old tree.
    // Same content → hash match → SyncEngine detects a rename and issues a MOVE instead of
    // delete + upload.
    a.vault.seedLocal('new/note.md', 'hello from old');
    a.vault.deleteLocalTree('old');
    await a.sync();

    // Remote: file now lives under new/, old/ is gone.
    expect(await baseClient.remoteExists('new/note.md')).toBe(true);
    expect(await baseClient.remoteExists('old/note.md')).toBe(false);
    expect(await baseClient.remoteExists('old')).toBe(false);

    // Device B picks up the rename.
    const b = makeDevice(env, ws.remoteBase, 'deviceB-dr1');
    await b.sync();
    expect(b.vault.localExists('new/note.md')).toBe(true);
    expect(b.vault.localExists('old/note.md')).toBe(false);
    expect(b.vault.folderExists('old')).toBe(false);
    expect(b.vault.folderExists('new')).toBe(true);
  });

  it('DR-concurrent: A renames 1111→2222, B independently creates 2222/other.md — both converge with no data loss', async () => {
    const env = getEnv();

    // Phase 1: A sets up the initial state and B picks it up.
    const a = makeDevice(env, ws.remoteBase, 'deviceA-dr2');
    const b = makeDevice(env, ws.remoteBase, 'deviceB-dr2');

    a.vault.seedLocal('anchor2.md', 'anchor');
    a.vault.seedLocal('1111/file.md', 'content-from-1111');
    await a.sync();

    await b.sync();
    expect(b.vault.localExists('1111/file.md')).toBe(true);

    // Concurrent divergence: A renames 1111 → 2222 locally; B creates a NEW file under 2222/.
    a.vault.seedLocal('2222/file.md', 'content-from-1111');
    a.vault.deleteLocalTree('1111');

    b.vault.seedLocal('2222/other.md', 'content-from-B');

    // A syncs first: MOVEs 1111/file.md → 2222/file.md, prunes 1111/, creates 2222/.
    await a.sync();

    expect(await baseClient.remoteExists('2222/file.md')).toBe(true);
    expect(await baseClient.remoteExists('1111')).toBe(false);

    // B syncs: uploads 2222/other.md, downloads 2222/file.md, sees 1111/ gone.
    await b.sync();
    expect(b.vault.localExists('2222/file.md')).toBe(true);
    expect(b.vault.localExists('2222/other.md')).toBe(true);
    expect(b.vault.folderExists('1111')).toBe(false);

    // A syncs again to pick up B's other.md — no data loss on either side.
    await a.sync();
    expect(a.vault.localExists('2222/file.md')).toBe(true);
    expect(a.vault.localExists('2222/other.md')).toBe(true);
  });
});
