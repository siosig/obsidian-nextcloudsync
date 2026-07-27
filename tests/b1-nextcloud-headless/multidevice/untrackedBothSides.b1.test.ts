// Layer B — feature 063 (GitHub issue #23), live server.
//
// Two devices create the SAME path independently, each without ever having seen the other's copy, so
// neither has a StateDB record for it. Device D uploads first; device M then syncs with its own local
// copy already on disk. The incremental path used to classify that as "remote changed only" and
// download straight over M's body — silent data loss. It must resolve as a conflict instead, and for
// .md that means both bodies survive the merge.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice, Device } from '../support/engineDevice';
import { decodeBuf } from '../support/helpers';

describeLive('Layer B — untracked file present on both sides (feature 063 / issue #23)', (getEnv) => {
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

  const remote = (p: string): Promise<string> => baseClient.downloadFile(p).then(decodeBuf);

  it('[SPEC:UBC-9] keeps BOTH bodies when the same .md was created independently on two devices', async () => {
    const file = 'ubc9-note.md';
    const D_BODY = 'shared heading\n\nline written on device D\n';
    const M_BODY = 'shared heading\n\nline written on device M\n';

    const d: Device = makeDevice(getEnv(), ws.remoteBase, 'ubc9-D');
    const m: Device = makeDevice(getEnv(), ws.remoteBase, 'ubc9-M');

    // D creates the note and pushes it. M independently creates its own note at the same path and
    // has NOT synced yet, so M's StateDB has no record for it.
    d.vault.seedLocal(file, D_BODY);
    await d.sync();
    expect(await remote(file)).toContain('device D');

    m.vault.seedLocal(file, M_BODY);
    expect(m.stateDB.getFile(file)).toBeUndefined(); // precondition: untracked on M

    await m.sync();

    // The whole point: M's local line must NOT have been silently replaced by D's copy.
    const mLocal = m.vault.readLocal(file);
    expect(mLocal).toContain('line written on device M');
    expect(mLocal).toContain('line written on device D');

    // And the merged result reaches the server so D picks it up too.
    const onServer = await remote(file);
    expect(onServer).toContain('line written on device M');

    await d.sync();
    expect(d.vault.readLocal(file)).toContain('line written on device M');
  }, 120_000);

  it('[SPEC:UBC-9] an untracked file that already matches the server converges without a transfer', async () => {
    const file = 'ubc9-same.md';
    const BODY = 'identical on both sides from the start\n';

    const d: Device = makeDevice(getEnv(), ws.remoteBase, 'ubc9b-D');
    const m: Device = makeDevice(getEnv(), ws.remoteBase, 'ubc9b-M');

    d.vault.seedLocal(file, BODY);
    await d.sync();

    // M happens to hold byte-identical content with no record of it.
    m.vault.seedLocal(file, BODY);
    expect(m.stateDB.getFile(file)).toBeUndefined();

    await m.sync();

    expect(m.vault.readLocal(file)).toBe(BODY);
    expect(m.stateDB.getFile(file)?.isConflicted).toBe(false);
    expect(await remote(file)).toBe(BODY);
  }, 120_000);
});
