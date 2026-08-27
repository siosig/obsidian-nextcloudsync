// Direct tests for ConflictApplier (feature 074, addendum).
//
// No [SPEC:...] tags: CF-*, MB-* and CSS-* stay with the engine-level suites.
//
// ConflictResolver decides; this carries it out. The property that runs through every branch is
// that NONE of them may report success they did not achieve: a state pairing the new local hash
// with the old remote id reads as "converged" to the next sync, and the merge then never reaches
// the other devices. Most of what is asserted below is that failure paths stay honest.
//
// Real strategies are driven through the real ConflictResolver rather than a stubbed decision, so
// the tests exercise the actual dispatch instead of a paraphrase of it.
import { ConflictApplier, ConflictDeps } from '../../../../src/sync/conflict/ConflictApplier';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { MergeBaseRecorder } from '../../../../src/sync/session/MergeBaseRecorder';
import { TransferService } from '../../../../src/sync/transfer/TransferService';
import { ResolutionService } from '../../../../src/sync/resolution/ResolutionService';
import { MergeConfig } from '../../../../src/sync/ConflictResolver';
import { FileState, RemoteFileInfo, SyncSessionSummary } from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import { IUploadStrategy } from '../../../../src/sync/upload/IUploadStrategy';

function summary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

const base = (path = 'note.md', over: Partial<FileState> = {}): FileState => ({
  path, localHash: 'base-hash', remoteId: 'old-remote', idType: 'etag', size: 5, mtime: 500,
  remoteFileId: 'fid', isConflicted: false, ...over,
});

const remoteInfo = (over: Partial<RemoteFileInfo> = {}): RemoteFileInfo => ({
  path: 'note.md', fileId: 'fid', checksum: null, etag: '"r1"', size: 20, lastModified: 2000, ...over,
});

const CONFIG: MergeConfig = {
  autoMergeFileTypes: ['md'],
  autoMergeFileStrategy: 'merge',
  otherFileStrategy: 'latest-mtime',
  deviceId: 'dev',
  frontmatterStrategy: 'merge',
  conflictStrategy: 'conflict-markers',
};

interface Opts {
  config?: Partial<MergeConfig>;
  /** Local file content and stat. */
  local?: { content: string; mtime: number; size: number };
  /** Remote body the client returns. */
  remoteBody?: string;
  /** Merge base body, '' when unknown. */
  mergeBase?: string;
  /** Make the upload fail (transient) or report 'skipped'. */
  upload?: 'ok' | 'skipped' | 'throw';
  oversize?: boolean;
}

function build(o: Opts = {}, over: Partial<ConflictDeps> = {}) {
  const local = o.local ?? { content: 'local body\n', mtime: 1000, size: 10 };
  let onDisk = local.content;

  const calls = {
    wrote: [] as string[],
    wroteBinary: [] as string[],
    setFile: [] as FileState[],
    history: [] as string[],
    retries: [] as string[],
    mergeBase: [] as string[],
    captured: [] as string[],
    rootEtag: [] as Array<string | null>,
    conflicts: 0,
    warned: [] as string[],
  };

  const client = {
    downloadFile: async () => new TextEncoder().encode(o.remoteBody ?? 'remote body\n').buffer,
  } as unknown as IWebDAVClient;

  const uploadStrategy = {
    upload: async () => {
      if (o.upload === 'throw') throw new Error('transient');
      return o.upload === 'skipped' ? 'skipped' : 'uploaded';
    },
  } as unknown as IUploadStrategy;

  const deps: ConflictDeps = {
    app: {} as unknown as ConflictDeps['app'],
    localAdapter: {
      stat: async () => ({ size: local.size, mtime: local.mtime }),
      read: async () => onDisk,
      readBinary: async () => new TextEncoder().encode(onDisk).buffer,
      atomicWrite: async (p: string, c: string) => { calls.wrote.push(p); onDisk = c; },
      atomicWriteBinary: async (p: string, d: ArrayBuffer) => {
        calls.wroteBinary.push(p); onDisk = new TextDecoder().decode(d);
      },
      setMtime: async () => { /* noop */ },
    } as unknown as ConflictDeps['localAdapter'],
    stateDB: {
      getFile: () => base(),
      setFile: (f: FileState) => { calls.setFile.push(f); },
      setRemoteRootEtag: (e: string | null) => { calls.rootEtag.push(e); },
    } as unknown as ConflictDeps['stateDB'],
    baseStore: { get: () => o.mergeBase ?? '' } as unknown as ConflictDeps['baseStore'],
    journal: Object.assign(new SyncJournal({}), {
      recordHistory: (p: string, op: string) => { calls.history.push(`${op}:${p}`); },
    }) as unknown as SyncJournal,
    mergeBase: {
      record: (p: string) => { calls.mergeBase.push(p); },
      drop: () => { /* noop */ },
    } as unknown as MergeBaseRecorder,
    transfer: {
      isRemoteOverSizeLimit: () => o.oversize === true,
      warnDownloadSkipped: (p: string) => { calls.warned.push(p); },
      acquireLock: async () => null,
      releaseLock: async () => { /* noop */ },
    } as unknown as TransferService,
    resolution: {
      captureCleanSides: (p: string) => { calls.captured.push(p); },
    } as unknown as ResolutionService,
    resolverConfig: () => ({ ...CONFIG, ...o.config }),
    maxFileSizeMB: () => 100,
    queueRetry: (p: string) => { calls.retries.push(p); },
    onConflictEncountered: () => { calls.conflicts++; },
    ...over,
  };

  return {
    applier: new ConflictApplier(deps),
    conn: { client, uploadStrategy },
    calls,
    diskContent: () => onDisk,
  };
}

describe('ConflictApplier.handleConflict — the size guard', () => {
  it('skips the whole conflict when the remote is over the cap, and does NOT queue a retry', async () => {
    // Re-fetching would fail the same way every sync; raising the cap self-heals it instead.
    const { applier, conn, calls } = build({ oversize: true });
    const s = summary();
    await applier.handleConflict(conn, 'note.md', base(), remoteInfo(), 'r', 'etag', s);
    expect(calls.warned).toEqual(['note.md']);
    expect(calls.retries).toEqual([]);
    expect(calls.wrote).toEqual([]);
    expect(s.conflictedCount).toBe(0); // not counted — nothing was decided
  });

  it('still flags the file conflicted so the UI surfaces it', async () => {
    const { applier, conn, calls } = build({ oversize: true });
    await applier.handleConflict(conn, 'note.md', base(), remoteInfo(), 'r', 'etag', summary());
    expect(calls.setFile[0]).toMatchObject({ path: 'note.md', isConflicted: true });
  });

  it('counts the encounter before anything else, so watch mode can notice it', async () => {
    const { applier, conn, calls } = build({ oversize: true });
    await applier.handleConflict(conn, 'note.md', base(), remoteInfo(), 'r', 'etag', summary());
    expect(calls.conflicts).toBe(1);
  });
});

describe('ConflictApplier.handleConflict — dispatching the resolver decision', () => {
  it('safe-hold: a non-text file under merge leaves BOTH sides untouched', async () => {
    const { applier, conn, calls } = build({
      config: { autoMergeFileTypes: ['bin'], autoMergeFileStrategy: 'merge' },
      // NUL bytes written as escapes, not literals: they are what makes the resolver classify this
      // as non-text (and therefore reach safe-hold), so they are load-bearing — but raw control
      // bytes in the source make git treat the whole file as binary and its diffs unreviewable.
      local: { content: '\u0000\u0001binary', mtime: 1000, size: 10 },
      remoteBody: '\u0000\u0002other',
    });
    const s = summary();
    await applier.handleConflict(conn, 'note.bin', base('note.bin'), remoteInfo({ path: 'note.bin' }), 'r', 'etag', s);
    expect(calls.wrote).toEqual([]);
    expect(calls.wroteBinary).toEqual([]);
    expect(s.conflictedCount).toBe(1);
    expect(calls.setFile[0]).toMatchObject({ isConflicted: true });
  });

  it('no-op: a deterministic tie invalidates the root ETag so the divergence is re-detected', async () => {
    // A tie leaves the two sides divergent with the state DB untouched and nothing pushed, so the
    // remote root ETag is unchanged. Left armed, the next sync would rebuild from stale state and
    // silently upload one side over the other.
    const { applier, conn, calls } = build({
      config: { autoMergeFileTypes: [], otherFileStrategy: 'latest-mtime' },
      local: { content: 'a', mtime: 2000, size: 20 },
    });
    const s = summary();
    await applier.handleConflict(conn, 'a.txt', base('a.txt'), remoteInfo({ path: 'a.txt', lastModified: 2000, size: 20 }), 'r', 'etag', s);
    expect(calls.rootEtag).toEqual([null]);
    expect(calls.setFile).toEqual([]);
    expect(s.conflictedCount).toBe(0);
    expect(s.errorCount).toBe(0);
  });

  it('prefer-local: uploads the local body and records it as the new base', async () => {
    const { applier, conn, calls } = build({
      config: { autoMergeFileTypes: [], otherFileStrategy: 'latest-mtime' },
      local: { content: 'newer local', mtime: 5000, size: 30 },
    });
    const s = summary();
    await applier.handleConflict(conn, 'a.txt', base('a.txt'), remoteInfo({ path: 'a.txt', lastModified: 1000 }), 'r', 'etag', s);
    expect(s.uploadedCount).toBe(1);
    expect(calls.history).toContain('local-wins:a.txt');
    expect(calls.mergeBase).toEqual(['a.txt']);
    expect(calls.setFile[0]).toMatchObject({ isConflicted: false, idType: 'sha256' });
  });

  it('prefer-remote: overwrites local and records the remote body as the new base', async () => {
    const { applier, conn, calls, diskContent } = build({
      config: { autoMergeFileTypes: [], otherFileStrategy: 'latest-mtime' },
      local: { content: 'older local', mtime: 1000, size: 5 },
      remoteBody: 'newer remote',
    });
    const s = summary();
    await applier.handleConflict(
      conn, 'a.txt', base('a.txt'), remoteInfo({ path: 'a.txt', lastModified: 9000, size: 12 }), 'r', 'etag', s,
    );
    expect(s.downloadedCount).toBe(1);
    expect(diskContent()).toBe('newer remote');
    expect(calls.history).toContain('remote-wins:a.txt');
    expect(calls.mergeBase).toEqual(['a.txt']);
  });
});

describe('ConflictApplier — capturing the clean sides before a marker write', () => {
  it('captures both sides when the resolution writes markers', async () => {
    // Divergent bodies with no common base ⇒ diff3 conflict ⇒ marker write (clean:false).
    const { applier, conn, calls } = build({
      local: { content: 'aaa\nlocal\nccc\n', mtime: 1000, size: 15 },
      remoteBody: 'aaa\nremote\nccc\n',
      mergeBase: 'aaa\nbase\nccc\n',
    });
    await applier.handleConflict(conn, 'note.md', base(), remoteInfo(), 'r', 'etag', summary());
    expect(calls.captured).toEqual(['note.md']);
  });

  it('captures nothing when the merge comes out clean', async () => {
    // Only one side moved away from the base ⇒ clean auto-merge, no marker, nothing buried.
    const { applier, conn, calls } = build({
      local: { content: 'aaa\nbase\nccc\n', mtime: 1000, size: 15 },
      remoteBody: 'aaa\nremote\nccc\n',
      mergeBase: 'aaa\nbase\nccc\n',
    });
    await applier.handleConflict(conn, 'note.md', base(), remoteInfo(), 'r', 'etag', summary());
    expect(calls.captured).toEqual([]);
  });
});

describe('ConflictApplier.resolveByWrite — a failed push must not read as converged', () => {
  const CLEAN_ARGS = ['note.md', 'merged body\n', true, remoteInfo(), 'old-remote', 'etag' as const, 1000] as const;

  it('records the merged body as the baseline once it reached the server', async () => {
    const { applier, conn, calls } = build({ upload: 'ok' });
    const s = summary();
    await applier.resolveByWrite(conn, ...CLEAN_ARGS, s);
    expect(s.mergedCount).toBe(1);
    expect(calls.setFile[0]).toMatchObject({ isConflicted: false, idType: 'sha256' });
    expect(calls.mergeBase).toEqual(['note.md']);
  });

  it('keeps the PREVIOUS baseline and stays conflicted when the push fails', async () => {
    // Feature 063: recording the merged hash here made the next sync read "both sides unchanged"
    // and take the converged arm, so the merge stayed local forever.
    const { applier, conn, calls } = build({ upload: 'throw' });
    const s = summary();
    await applier.resolveByWrite(conn, ...CLEAN_ARGS, s);
    const written = calls.setFile[0];
    expect(written.localHash).toBe('base-hash');   // NOT the merged hash
    expect(written.remoteId).toBe('old-remote');
    expect(written.isConflicted).toBe(true);       // even though the merge was clean
    expect(calls.retries).toEqual(['note.md']);
  });

  it('does not advance the merge base when the push failed', async () => {
    const { applier, conn, calls } = build({ upload: 'throw' });
    await applier.resolveByWrite(conn, ...CLEAN_ARGS, summary());
    expect(calls.mergeBase).toEqual([]); // the sides have not converged
  });

  it('omits the stat signature after a failed push so the next sync re-hashes', async () => {
    // A signature would let the local-unchanged fast path skip the re-hash that drives the retry.
    const okRun = build({ upload: 'ok' });
    await okRun.applier.resolveByWrite(okRun.conn, ...CLEAN_ARGS, summary());
    expect(okRun.calls.setFile[0].localMtime).toBeDefined();

    const failRun = build({ upload: 'throw' });
    await failRun.applier.resolveByWrite(failRun.conn, ...CLEAN_ARGS, summary());
    expect(failRun.calls.setFile[0].localMtime).toBeUndefined();
  });

  it('keeps a marker write conflicted even when it uploaded fine', async () => {
    const { applier, conn, calls } = build({ upload: 'ok' });
    const s = summary();
    await applier.resolveByWrite(conn, 'note.md', 'markers\n', false, remoteInfo(), 'old-remote', 'etag', 1000, s);
    expect(s.conflictedCount).toBe(1);
    expect(s.mergedCount).toBe(0);
    expect(calls.setFile[0].isConflicted).toBe(true);
    expect(calls.mergeBase).toEqual([]); // markers are never a merge base
  });

  it('treats a skipped upload as not uploaded', async () => {
    const { applier, conn, calls } = build({ upload: 'skipped' });
    const s = summary();
    await applier.resolveByWrite(conn, ...CLEAN_ARGS, s);
    expect(s.uploadedCount).toBe(0);
    expect(calls.setFile[0].isConflicted).toBe(true);
  });
});

describe('ConflictApplier.resolveByPreferLocal / resolveByPreferRemote — failure honesty', () => {
  it('prefer-local: an upload failure records the error and never marks it resolved', async () => {
    const { applier, conn, calls } = build({ upload: 'throw' });
    const s = summary();
    await applier.resolveByPreferLocal(conn, 'note.md', remoteInfo(), s);
    expect(s.errorCount).toBe(1);
    expect(s.uploadedCount).toBe(0);
    expect(calls.retries).toEqual(['note.md']);
    expect(calls.setFile).toEqual([]); // nothing claimed as converged
  });

  it('prefer-local: a skipped upload queues a retry without recording an error', async () => {
    const { applier, conn, calls } = build({ upload: 'skipped' });
    const s = summary();
    await applier.resolveByPreferLocal(conn, 'note.md', remoteInfo(), s);
    expect(s.errorCount).toBe(0);
    expect(calls.retries).toEqual(['note.md']);
    expect(calls.setFile).toEqual([]);
  });

  it('prefer-remote: refuses an EMPTY body for a file advertised as non-empty', async () => {
    const { applier, calls, diskContent } = build();
    const s = summary();
    await applier.resolveByPreferRemote('note.md', remoteInfo({ size: 20 }), new ArrayBuffer(0), 'r', 'etag', s);
    expect(s.errorCount).toBe(1);
    expect(calls.wroteBinary).toEqual([]);
    expect(diskContent()).toBe('local body\n'); // local untouched
    expect(calls.retries).toEqual(['note.md']);
  });

  it('prefer-remote: ACCEPTS a non-zero length that disagrees with the advertised size', async () => {
    // Spec 025 deliberately does not flag a size mismatch. Obsidian's requestUrl on iOS reports a
    // byte count that drifts from the server's content-length on multi-byte content, and treating
    // that as an anomaly refused legitimate downloads outright (a remote→local sync gap in 0.7.7).
    // Only a genuinely empty body is anomalous. This test exists to stop that guard being widened
    // back to "any mismatch".
    const { applier, calls } = build();
    const s = summary();
    const body = new TextEncoder().encode('x').buffer; // advertised 20, received 1
    await applier.resolveByPreferRemote('note.md', remoteInfo({ size: 20 }), body, 'r', 'etag', s);
    expect(s.errorCount).toBe(0);
    expect(calls.wroteBinary).toEqual(['note.md']);
  });

  it('prefer-remote: accepts a legitimately empty file', async () => {
    const { applier, calls } = build();
    const s = summary();
    await applier.resolveByPreferRemote('note.md', remoteInfo({ size: 0 }), new ArrayBuffer(0), 'r', 'etag', s);
    expect(s.errorCount).toBe(0);
    expect(calls.wroteBinary).toEqual(['note.md']);
  });

  it('prefer-remote: a local write failure keeps the conflict and retries', async () => {
    const { applier, calls } = build({}, {
      localAdapter: {
        stat: async () => ({ size: 10, mtime: 1000 }),
        read: async () => 'x',
        readBinary: async () => new ArrayBuffer(1),
        atomicWrite: async () => { /* noop */ },
        atomicWriteBinary: async () => { throw new Error('EACCES'); },
        setMtime: async () => { /* noop */ },
      } as unknown as ConflictDeps['localAdapter'],
    });
    const s = summary();
    const body = new TextEncoder().encode('12345678901234567890').buffer;
    await applier.resolveByPreferRemote('note.md', remoteInfo({ size: 20 }), body, 'r', 'etag', s);
    expect(s.errorCount).toBe(1);
    expect(calls.setFile).toEqual([]);
    expect(calls.retries).toEqual(['note.md']);
  });
});
