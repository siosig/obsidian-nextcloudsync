// Spec-conformance: SyncEngine integration (spec-level, driven via an in-memory
// vault + shared FakeRemote). Asserts the SPEC's expected end-to-end behavior so a
// deviation surfaces as a FAIL — NOT relying on existing implementation-shaped tests.
import { makeDevice } from './support/engineHarness';
import { FakeRemote } from './support/fakeRemote';

describe('SyncEngine integration — spec conformance', () => {
  it('001 FR-001: bidirectional sync — A uploads, a fresh B downloads it', async () => {
    const remote = new FakeRemote();
    const a = await makeDevice('deviceA', remote);
    a.vault.seedLocal('note.md', 'hello from A');
    await a.sync();
    expect(remote.files.has('note.md')).toBe(true);

    const b = await makeDevice('deviceB', remote);
    await b.sync();
    expect(b.vault.readLocal('note.md')).toBe('hello from A');
  });

  it('001 FR-005: downloads are atomic (no leftover .tmp; final content present)', async () => {
    const remote = new FakeRemote();
    const a = await makeDevice('deviceA', remote);
    a.vault.seedLocal('atomic.md', 'body');
    await a.sync();
    const b = await makeDevice('deviceB', remote);
    await b.sync();
    expect(b.vault.readLocal('atomic.md')).toBe('body');
    expect(b.vault.localExists('atomic.md.nextcloudsync.tmp')).toBe(false);
  });

  it('001 FR-007: each device keeps independent state (separate state files)', async () => {
    const remote = new FakeRemote();
    const a = await makeDevice('deviceA', remote);
    a.vault.seedLocal('x.md', 'x');
    await a.sync();
    // A's state tracks x.md; a brand-new device B has empty state until it syncs.
    const b = await makeDevice('deviceB', remote);
    expect(b.stateDB.getAllFiles().length).toBe(0);
    await b.sync();
    expect(b.stateDB.getFile('x.md')).toBeDefined();
    expect(a.stateDB.getDeviceId()).toBe('deviceA');
    expect(b.stateDB.getDeviceId()).toBe('deviceB');
  });

  it('003 FR-001: a remote deletion is applied locally (full-scan absence detection)', async () => {
    // SPEC: a remote deletion propagates to the local copy (honoring trash). The engine
    // implements this even on full-scan (processLocalModifications absence detection:
    // tracked + locally-present + remote-absent + content-unchanged → delete, guarded by a
    // mass-delete circuit breaker and a 404 re-check). It INTENTIONALLY skips when the remote
    // listing is empty (size 0) — a guard against a truncated/failed listing — so we keep
    // another file on the remote to exercise the real deletion path.
    const remote = new FakeRemote();
    const a = await makeDevice('deviceA', remote);
    a.vault.seedLocal('keep.md', 'stays');
    a.vault.seedLocal('del.md', 'gone soon');
    await a.sync();
    const b = await makeDevice('deviceB', remote);
    await b.sync();
    expect(b.vault.localExists('del.md')).toBe(true);
    // Delete del.md on the remote (keep.md remains → listing non-empty); B re-syncs.
    await remote.deleteFile('del.md', '');
    await b.sync();
    expect(b.vault.localExists('del.md')).toBe(false);
    expect(b.vault.localExists('keep.md')).toBe(true);
  });

  it('010 FR-010: a converged file (identical both sides) is not flagged conflicted', async () => {
    const remote = new FakeRemote();
    const a = await makeDevice('deviceA', remote);
    a.vault.seedLocal('same.md', 'identical');
    await a.sync();
    const b = await makeDevice('deviceB', remote);
    b.vault.seedLocal('same.md', 'identical'); // same content as remote
    await b.sync();
    expect(b.stateDB.countConflicted()).toBe(0);
  });

  it('015 FR-003: an unchanged file on re-sync is not re-uploaded (fast-path)', async () => {
    const remote = new FakeRemote();
    const a = await makeDevice('deviceA', remote);
    a.vault.seedLocal('stable.md', 'v1');
    await a.sync();
    const etag1 = remote.files.get('stable.md')?.etag;
    await a.sync(); // no local change
    const etag2 = remote.files.get('stable.md')?.etag;
    expect(etag2).toBe(etag1); // not re-uploaded
  });
});
