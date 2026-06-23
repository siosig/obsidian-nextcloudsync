// Layer B — cross-device SYNC INVARIANTS (live server, 2 devices D=desktop / M=mobile-style).
//
// Proves the anomalies the user asked about NEVER occur across scenarios beyond plain edit×edit
// (which conflictPolicyMatrix already covers):
//   (1) data loss            — neither side's content is silently dropped
//   (2) infinite churn       — repeated no-op syncs do not keep mutating remote/local (root ETag stable)
//   (3) remote→local gap     — a remote change always reaches local
//   (4) local→remote gap     — a local change always reaches remote
//   (5) other async anomalies — delete×edit, rename×edit, dir-delete×nested-edit, mass-delete breaker,
//                               concurrent create, non-mergeable conflict, frontmatter+body merge.
//
// Scenario catalog co-designed via the Gemini "gemini-team" (architect + devil's-advocate critic).
// Manual only (pnpm test:b1 -- syncInvariants); skips without .env NEXTCLOUD_*.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice, Device } from '../support/engineDevice';
import { decodeBuf } from '../support/helpers';
import { DavSyncSettings } from '../../../src/types';

describeLive('Layer B — cross-device sync invariants', (getEnv) => {
  let ws: IsolatedWorkspace;
  let baseClient: NextcloudClient;

  beforeAll(async () => {
    const s = await setupWorkspace(getEnv());
    ws = s.ws;
    baseClient = s.client;
  });
  afterAll(async () => { if (baseClient && ws) await cleanupWorkspace(baseClient, ws); });

  const remoteText = (p: string): Promise<string> => baseClient.downloadFile(p).then(decodeBuf);
  const remoteExists = (p: string): Promise<boolean> => baseClient.remoteExists(p);
  const rootEtag = (): Promise<string | null> => baseClient.getRootEtag();
  const dev = (id: string, over: Partial<DavSyncSettings> = {}): Device => makeDevice(getEnv(), ws.remoteBase, id, over);

  // A no-op sync must not mutate the remote tree (no churn): the vault root ETag is unchanged.
  async function assertNoChurn(d: Device, label: string): Promise<void> {
    const before = await rootEtag();
    await d.sync();
    await d.sync();
    const after = await rootEtag();
    expect(`${label}: ${after}`).toBe(`${label}: ${before}`);
  }

  it('INV-1 no-change syncs are no-ops (no infinite churn): root ETag stays stable', async () => {
    const d = dev('inv1-D'); const m = dev('inv1-M');
    d.vault.seedLocal('inv1.md', 'stable\n');
    await d.sync(); await m.sync();
    expect(m.vault.readLocal('inv1.md')).toBe('stable\n');
    await assertNoChurn(d, 'inv1-D'); await assertNoChurn(m, 'inv1-M');
  }, 120_000);

  it('INV-2/3 local→remote and remote→local propagation both directions', async () => {
    const d = dev('inv2-D'); const m = dev('inv2-M');
    d.vault.seedLocal('inv2.md', 'v0\n'); await d.sync(); await m.sync();
    // local→remote: M edits, syncs; remote must reflect it, then D pulls it.
    m.vault.seedLocal('inv2.md', 'from-M\n'); await m.sync();
    expect(await remoteText('inv2.md')).toBe('from-M\n');          // (4) local→remote
    await d.sync();
    expect(d.vault.readLocal('inv2.md')).toBe('from-M\n');         // (3) remote→local
    // remote→local: D edits, syncs; M pulls it.
    d.vault.seedLocal('inv2.md', 'from-D\n'); await d.sync();
    await m.sync();
    expect(m.vault.readLocal('inv2.md')).toBe('from-D\n');         // (3) remote→local
    await assertNoChurn(m, 'inv2-M');
  }, 120_000);

  it('INV-4 remote delete propagates to local trash (and local delete propagates to remote)', async () => {
    const d = dev('inv4-D'); const m = dev('inv4-M');
    d.vault.seedLocal('anchor.md', 'a'); d.vault.seedLocal('inv4.md', 'x\n');
    await d.sync(); await m.sync();
    expect(m.vault.localExists('inv4.md')).toBe(true);
    d.vault.deleteLocalTree('inv4.md'); await d.sync();           // local delete → remote delete
    expect(await remoteExists('inv4.md')).toBe(false);
    await m.sync();                                                // remote delete → local trash
    expect(m.vault.localExists('inv4.md')).toBe(false);
  }, 120_000);

  it('INV-5 delete×edit: local delete is CANCELLED when remote was edited (no data loss = restore)', async () => {
    const d = dev('inv5-D'); const m = dev('inv5-M');
    d.vault.seedLocal('anchor.md', 'a'); d.vault.seedLocal('inv5.md', 'base\n');
    await d.sync(); await m.sync();
    m.vault.seedLocal('inv5.md', 'edited-by-M\n'); await m.sync(); // remote now diverges from D's base
    d.vault.deleteLocalTree('inv5.md');                            // D deletes locally (stale base)
    await d.sync();
    // Deletion safety: remote != base → delete cancelled, remote edit restored locally. No data loss.
    expect(await remoteExists('inv5.md')).toBe(true);
    expect(await remoteText('inv5.md')).toBe('edited-by-M\n');
    expect(d.vault.readLocal('inv5.md')).toBe('edited-by-M\n');
  }, 120_000);

  it('INV-6 rename×edit: rename preserved AND the concurrent remote edit survives (no data loss)', async () => {
    const d = dev('inv6-D'); const m = dev('inv6-M');
    d.vault.seedLocal('anchor.md', 'a'); d.vault.seedLocal('inv6-a.md', 'content\n');
    await d.sync(); await m.sync();
    m.vault.seedLocal('inv6-a.md', 'edited-by-M\n'); await m.sync(); // remote a edited
    // D renames a→b (same content "content"), unaware of M's edit.
    d.vault.seedLocal('inv6-b.md', 'content\n'); d.vault.deleteLocalTree('inv6-a.md');
    await d.sync(); await d.sync();
    // b (renamed) preserved; a's remote edit not lost (restored, base-match failed the MOVE/delete).
    expect(await remoteExists('inv6-b.md')).toBe(true);
    expect(await remoteText('inv6-b.md')).toBe('content\n');
    expect(d.vault.readLocal('inv6-a.md')).toBe('edited-by-M\n');
    expect(await remoteText('inv6-a.md')).toBe('edited-by-M\n');
  }, 180_000);

  it('INV-7 concurrent create same-path (conflict-markers): both versions preserved, converges, no churn', async () => {
    // autoMerge OFF so the failure policy (markers) actually fires; with autoMerge ON the two creates
    // would be auto-merged instead (also lossless, but a different path tested by INV-9).
    const over: Partial<DavSyncSettings> = { autoMergeEnabled: false, conflictFailurePolicy: 'conflict-markers' };
    const d = dev('inv7-D', over); const m = dev('inv7-M', over);
    d.vault.seedLocal('inv7.md', 'D-content\n');
    m.vault.seedLocal('inv7.md', 'M-content\n');
    await d.sync();                                  // remote = D-content
    await m.sync();                                  // M: remote exists, no base → conflict → markers
    const mLocal = m.vault.readLocal('inv7.md')!;
    expect(/^<<<<<<< /m.test(mLocal) || mLocal.includes('#conflict')).toBe(true);
    expect(mLocal).toContain('D-content');
    expect(mLocal).toContain('M-content');           // no data loss: both kept
    expect(await remoteText('inv7.md')).toBe(mLocal); // pushed → converged
    await assertNoChurn(m, 'inv7-M');                 // critic #6: marker file does not re-upload forever
  }, 120_000);

  it('INV-8 non-mergeable (binary) conflict + conflict-markers: NO marker injection, file intact', async () => {
    const over: Partial<DavSyncSettings> = { conflictFailurePolicy: 'conflict-markers' };
    const d = dev('inv8-D', over); const m = dev('inv8-M', over);
    d.vault.seedLocal('anchor.md', 'a'); d.vault.seedLocal('inv8.bin', 'BIN-base');
    await d.sync(); await m.sync();
    d.vault.seedLocal('inv8.bin', 'BIN-from-D'); await d.sync();
    m.vault.seedLocal('inv8.bin', 'BIN-from-M'); await m.sync();   // conflict on non-mergeable
    const mBin = m.vault.readLocal('inv8.bin')!;
    expect(mBin).toBe('BIN-from-M');                 // untouched: no markers written into a binary
    expect(mBin).not.toContain('<<<<<<<');
    expect(m.stateDB.getFile('inv8.bin')?.isConflicted ?? false).toBe(true);
  }, 120_000);

  it('INV-9 auto-merge of concurrent frontmatter + body edits: both survive, no duplication, converges', async () => {
    const over: Partial<DavSyncSettings> = { autoMergeEnabled: true, frontmatterConflictStrategy: 'local-wins' };
    const d = dev('inv9-D', over); const m = dev('inv9-M', over);
    const base = '---\ntitle: base\n---\n\nbody line one\nbody line two\n';
    d.vault.seedLocal('inv9.md', base); await d.sync(); await m.sync();
    // D edits BODY (line two); M edits FRONTMATTER (title). Disjoint regions.
    d.vault.seedLocal('inv9.md', '---\ntitle: base\n---\n\nbody line one\nbody line TWO-D\n'); await d.sync();
    m.vault.seedLocal('inv9.md', '---\ntitle: from-M\n---\n\nbody line one\nbody line two\n'); await m.sync();
    const merged = m.vault.readLocal('inv9.md')!;
    expect(merged).toContain('TWO-D');               // D's body edit survived
    expect(merged).toContain('from-M');              // M's frontmatter edit survived
    expect((merged.match(/body line one/g) ?? []).length).toBe(1); // no duplication (empty-base merge safe)
    expect(await remoteText('inv9.md')).toBe(merged); // converged
    await assertNoChurn(m, 'inv9-M');
  }, 150_000);

  it('INV-10 opposite/identical aggressive policies converge (no infinite ping-pong)', async () => {
    // Both local-wins is the worst oscillation candidate; prove it converges (last-writer-wins) + stable.
    const over: Partial<DavSyncSettings> = { autoMergeEnabled: false, conflictFailurePolicy: 'local-wins' };
    const d = dev('inv10-D', over); const m = dev('inv10-M', over);
    d.vault.seedLocal('inv10.md', 'base\n'); await d.sync(); await m.sync();
    d.vault.seedLocal('inv10.md', 'D-edit\n'); m.vault.seedLocal('inv10.md', 'M-edit\n');
    await d.sync();                                  // remote = D-edit
    await m.sync();                                  // conflict, M local-wins → remote = M-edit, M base = M-edit
    await d.sync();                                  // D local==base(D-edit), remote=M-edit → download (not conflict)
    await m.sync();
    // Converged to a single value on both sides; further syncs are no-ops (no ping-pong).
    const finalRemote = await remoteText('inv10.md');
    expect(d.vault.readLocal('inv10.md')).toBe(finalRemote);
    expect(m.vault.readLocal('inv10.md')).toBe(finalRemote);
    await assertNoChurn(d, 'inv10-D'); await assertNoChurn(m, 'inv10-M');
  }, 180_000);

  it('INV-11 mass-delete breaker trips → records error → forces a real scan next time (no stale short-circuit)', async () => {
    // critic #3 / spec 023 §8a.5 convergence gate: a tripped breaker must invalidate the root ETag so
    // "re-sync to retry" actually re-evaluates, instead of short-circuiting forever on stale State.
    const d = dev('inv11-D'); const m = dev('inv11-M');
    d.vault.seedLocal('bulk/keep.md', 'keep\n'); // keeps the folder alive so this exercises the FILE
    for (let i = 0; i < 25; i++) d.vault.seedLocal(`bulk/f${i}.md`, `f${i}\n`); // breaker, not folder-trash
    await d.sync(); await m.sync();
    expect(m.vault.localExists('bulk/f0.md')).toBe(true);
    // D deletes the 25 files individually (folder stays via keep.md) → remote loses 25 files.
    // M then syncs: 25 absence-deletions > max(20, 20% of tracked) → the file mass-delete breaker trips.
    for (let i = 0; i < 25; i++) d.vault.deleteLocalTree(`bulk/f${i}.md`);
    await d.sync();
    const e1 = await rootEtag();
    await m.sync();
    // Breaker protected local data (files kept) AND invalidated the stored root ETag.
    expect(m.vault.localExists('bulk/f0.md')).toBe(true);        // not mass-deleted locally
    expect(m.stateDB.getRemoteRootEtag()).toBeNull();            // gate invalidated → next sync real-scans
    expect(e1).not.toBeNull();                                   // remote genuinely changed (sanity)
  }, 180_000);

  // FIXED in spec 024 (was a confirmed bug found by the Gemini devil's-advocate critic #1): when the
  // remote folder was deleted by another device and this device holds UN-PUSHED edits/creates under it,
  // the upload into the now-missing parent failed with HTTP 404 ("<Folder> could not be located") and
  // never recovered, because NextcloudClient's in-session "createdDirs" cache held a stale positive for
  // the (since-deleted) folder, so reactive MKCOL skipped re-creating it. Fixed by dropping the stale
  // ancestor cache entries on a 404/409 before re-issuing MKCOL. This is now a permanent regression test.
  it('INV-12 dir-delete (remote) × nested local edit/create: nested upload survives (no data loss)', async () => {
    const d = dev('inv12-D'); const m = dev('inv12-M');
    d.vault.seedLocal('anchor.md', 'a');
    d.vault.seedLocal('Folder/note.md', 'note-base\n');
    await d.sync(); await m.sync();
    // M removes the whole folder and syncs → remote Folder/ + note.md deleted.
    m.vault.deleteLocalTree('Folder'); await m.sync();
    expect(await remoteExists('Folder/note.md')).toBe(false);
    // D (stale) edits the nested note AND creates a new nested file, then syncs.
    d.vault.seedLocal('Folder/note.md', 'note-EDITED-by-D\n');
    d.vault.seedLocal('Folder/new.md', 'brand-new\n');
    // Probe right after D's first sync: D's authored content must reach the remote (not be trashed).
    await d.sync();
    expect(await remoteExists('Folder/new.md')).toBe(true);   // [probe] new file pushed
    expect(await remoteExists('Folder/note.md')).toBe(true);  // [probe] edited file restored/pushed
    expect(d.vault.localExists('Folder/new.md')).toBe(true);  // [probe] not trashed locally by dir reconcile
    // Converge with a few more rounds on both devices.
    await m.sync(); await d.sync(); await m.sync();
    // INVARIANT: D's authored content is NOT lost — it survives on remote and on D, and reaches M.
    expect(await remoteExists('Folder/new.md')).toBe(true);
    expect(await remoteText('Folder/new.md')).toBe('brand-new\n');
    expect(await remoteExists('Folder/note.md')).toBe(true);
    expect(await remoteText('Folder/note.md')).toBe('note-EDITED-by-D\n');
    expect(d.vault.readLocal('Folder/new.md')).toBe('brand-new\n');
    expect(d.vault.readLocal('Folder/note.md')).toBe('note-EDITED-by-D\n');
    // And the system converges (no churn after).
    await assertNoChurn(d, 'inv12-D');
  }, 240_000);
});
