// Layer B — clean-side snapshot recovery (feature 044), live server.
// Two devices produce a same-line body conflict under the Merge strategy → markers are written locally
// AND pushed, so both local and remote hold the marker content (the note is flagged conflicted). This
// is exactly the case where force-resolution used to recover NOTHING (it re-synced markers) while
// clearing the flag. With feature 044 the two clean sides captured at conflict time let force-resolution
// restore a real clean version.
//
// forceResolution's "Use remote" / "Use local" reduce to the SyncEngine CompareEngine methods
// (applyCleanRemote / applyCleanLocal when a snapshot exists). We drive those directly on the resolver
// device, exactly as the Sync dialog does.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice, Device } from '../support/engineDevice';
import { decodeBuf } from '../support/helpers';
import { applyForceResolution } from '../../../src/ui/forceResolution';

/** True when any line is a plugin conflict-marker line. */
function hasMarkers(s: string): boolean {
  return /^(?:<<<<<<<|=======|>>>>>>>)/m.test(s);
}

describeLive('Layer B — clean-side snapshot recovery (044) across D/M', (getEnv) => {
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

  /** Drive a same-line conflict on `f` so M writes markers (pushed to the server) and is flagged conflicted. */
  async function markerConflict(f: string): Promise<{ d: Device; m: Device }> {
    const env = getEnv();
    const d = makeDevice(env, ws.remoteBase, 'D-desktop');
    const m = makeDevice(env, ws.remoteBase, 'M-iphone', { syncIntervalMinutes: 0, watchOnChangeEnabled: false });
    d.vault.seedLocal('anchor.md', 'anchor');
    d.vault.seedLocal(f, 'top\nMIDDLE\nbottom\n');
    await d.sync();
    await m.sync(); // M has the base
    // Both edit the SAME middle line differently → same-line conflict → markers.
    d.vault.seedLocal(f, 'top\nD-EDIT\nbottom\n');
    await d.sync();
    m.vault.seedLocal(f, 'top\nM-EDIT\nbottom\n');
    await m.sync(); // M conflicts, writes markers locally AND pushes them
    return { d, m };
  }

  it('[SPEC:CSS-B1-1] Use remote recovers the clean REMOTE side (marker-free) and both sides converge', async () => {
    const f = 'css-b1-1.md';
    const { m } = await markerConflict(f);
    // Precondition: the conflict really wrote markers to BOTH sides.
    expect(hasMarkers(m.vault.readLocal(f)!)).toBe(true);
    expect(hasMarkers(await remote(f))).toBe(true);

    // "Use remote" via the same entry point the Sync dialog uses.
    expect(await applyForceResolution(m.engine, f, 'remote')).toBe('applied');

    const local = m.vault.readLocal(f)!;
    expect(hasMarkers(local)).toBe(false);          // recovered a CLEAN version, not the markers
    expect(local).toContain('D-EDIT');              // the clean remote side (D's edit)
    expect(local).not.toContain('M-EDIT');
    expect(await remote(f)).toBe(local);            // both sides converged on the clean remote
    expect(m.stateDB.getFile(f)?.isConflicted ?? false).toBe(false); // flag cleared, note is clean
  }, 180_000);

  it('[SPEC:CSS-B1-2] Use local recovers the clean LOCAL side (marker-free) and both sides converge', async () => {
    const f = 'css-b1-2.md';
    const { m } = await markerConflict(f);
    expect(hasMarkers(m.vault.readLocal(f)!)).toBe(true);

    expect(await applyForceResolution(m.engine, f, 'local')).toBe('applied');

    const local = m.vault.readLocal(f)!;
    expect(hasMarkers(local)).toBe(false);
    expect(local).toContain('M-EDIT');              // the clean local side (M's edit)
    expect(local).not.toContain('D-EDIT');
    expect(await remote(f)).toBe(local);
    expect(m.stateDB.getFile(f)?.isConflicted ?? false).toBe(false);
  }, 180_000);

  it('[SPEC:CSS-B1-3] after recovery, a further no-edit sync converges with no marker growth and no snapshot leak', async () => {
    const f = 'css-b1-3.md';
    const { d, m } = await markerConflict(f);
    await applyForceResolution(m.engine, f, 'remote');
    const recovered = m.vault.readLocal(f)!;

    // Re-sync both devices with no edits: stable, marker-free, and the snapshot is gone (bounded store).
    await m.sync();
    await d.sync();
    expect(m.vault.readLocal(f)).toBe(recovered);
    expect(hasMarkers(m.vault.readLocal(f)!)).toBe(false);
    expect(m.baseStore).toBeDefined();
    // No snapshot leak: the resolved path retains no captured clean sides.
    const store = (m.engine as unknown as { opts: { cleanSideStore?: { get(p: string): unknown } } }).opts.cleanSideStore;
    expect(store?.get(f)).toBeUndefined();
    // D also converges onto the recovered clean content.
    expect(d.vault.readLocal(f)).toBe(recovered);
  }, 240_000);
});
