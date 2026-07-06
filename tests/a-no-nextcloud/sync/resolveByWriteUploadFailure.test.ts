// [G1-1] REGRESSION: SyncEngine.resolveByWrite must not mark a clean merge "resolved" when the
// re-upload of the merged content fails.
//
// Root cause (static-analysis report G1-1): the committed FileState set `isConflicted: !clean`
// UNCONDITIONALLY, while `remoteId`/`idType` (and, on the caller's side, `recordMergeBase`) were
// already correctly gated on `uploaded`. So a clean auto-merge whose PUT fails (423 locked / 412
// precondition / network error) committed: isConflicted:false (from clean:true) + localHash = the
// NEW merged hash + remoteId = the OLD (still-on-server) id. The next sync then reads this as
// "local unchanged since base, remote unchanged since base" → converged — and the merged content is
// silently never retried and never reaches the server or any other device.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { NetworkError, RemoteFileInfo, SyncSessionSummary, FileState } from '../../../src/types';

type ResolveByWrite = (
  path: string, content: string, clean: boolean, remote: RemoteFileInfo,
  remoteId: string, idType: FileState['idType'], localMtimeBefore: number, summary: SyncSessionSummary,
) => Promise<void>;

function initSummary(): SyncSessionSummary {
  return {
    startedAt: Date.now(), completedAt: null,
    uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0,
    errorCount: 0, retriedFiles: [], errors: [],
  };
}

function makeEngine() {
  const setFileCalls: FileState[] = [];
  const opts = {
    app: {}, settings: {},
    localAdapter: {
      atomicWrite: jest.fn(async () => undefined),
      setMtime: jest.fn(async () => undefined),
      readBinary: jest.fn(async () => new TextEncoder().encode('merged content').buffer),
      stat: jest.fn(async () => ({ size: 14, mtime: Date.now() })),
    },
    stateDB: {
      setFile: jest.fn((fs: FileState) => { setFileCalls.push(fs); }),
    },
    statusBar: {}, webdavFactory: {}, pluginDir: '', configDir: '.obsidian',
  };
  const engine = new SyncEngine(opts as never);
  return { engine, setFileCalls };
}

describe('[G1-1] SyncEngine.resolveByWrite — merge upload failure must not look converged', () => {
  it('keeps isConflicted:true when clean=true but the merge re-upload throws', async () => {
    const { engine, setFileCalls } = makeEngine();
    // Simulate a failing upload strategy (423 locked / 412 / network) — never resolves 'skipped', always throws.
    (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = {
      upload: jest.fn(async () => { throw new NetworkError(423, 'Locked'); }),
    };
    (engine as unknown as { client: unknown }).client = {};

    const summary = initSummary();
    const remote: RemoteFileInfo = { path: 'note.md', fileId: 'remote-file-id', checksum: null, etag: 'e1', size: 10, lastModified: Date.now() };

    await (engine as unknown as { resolveByWrite: ResolveByWrite }).resolveByWrite(
      'note.md', 'merged content', /* clean */ true, remote, 'old-remote-id', 'sha256', Date.now(), summary,
    );

    expect(setFileCalls).toHaveLength(1);
    const written = setFileCalls[0];
    // BUG guard: the merge did NOT reach the server, so it must still read as unresolved/pending —
    // otherwise the next sync sees local==base(new hash) and remote==base(old id) and never retries.
    expect(written.isConflicted).toBe(true);
    // remoteId/idType stay pinned to the OLD (still-accurate) values — unchanged by this fix, but
    // asserted here to pin down the exact bug: these were ALREADY correctly gated on `uploaded`.
    expect(written.remoteId).toBe('old-remote-id');
    expect(written.idType).toBe('sha256');
    expect(summary.mergedCount).toBe(1); // still counted as a clean merge for the session summary
    expect(summary.conflictedCount).toBe(0);
  });

  it('happy path unaffected: clean merge whose upload SUCCEEDS still converges (isConflicted:false)', async () => {
    const { engine, setFileCalls } = makeEngine();
    (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = {
      upload: jest.fn(async () => 'uploaded'),
    };
    (engine as unknown as { client: unknown }).client = {};

    const summary = initSummary();
    const remote: RemoteFileInfo = { path: 'note.md', fileId: 'remote-file-id', checksum: null, etag: 'e1', size: 10, lastModified: Date.now() };

    await (engine as unknown as { resolveByWrite: ResolveByWrite }).resolveByWrite(
      'note.md', 'merged content', /* clean */ true, remote, 'old-remote-id', 'sha256', Date.now(), summary,
    );

    expect(setFileCalls).toHaveLength(1);
    expect(setFileCalls[0].isConflicted).toBe(false);
  });

  it('marker-write path (clean=false) stays conflicted regardless of upload outcome', async () => {
    const { engine, setFileCalls } = makeEngine();
    (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = {
      upload: jest.fn(async () => 'uploaded'),
    };
    (engine as unknown as { client: unknown }).client = {};

    const summary = initSummary();
    const remote: RemoteFileInfo = { path: 'note.md', fileId: 'remote-file-id', checksum: null, etag: 'e1', size: 10, lastModified: Date.now() };

    await (engine as unknown as { resolveByWrite: ResolveByWrite }).resolveByWrite(
      'note.md', '<<<<<<< marker content', /* clean */ false, remote, 'old-remote-id', 'sha256', Date.now(), summary,
    );

    expect(setFileCalls[0].isConflicted).toBe(true);
    expect(summary.conflictedCount).toBe(1);
  });
});
