// Direct tests for ConflictApplier.
//
// No [SPEC:...] tags: CF-*, MB-* and CSS-* stay with the engine-level suites.
// ConflictResolver decides; this carries it out, and no branch may report success it did not achieve:
// a state pairing the new local hash with the old remote id reads as "converged" to the next sync,
// so the merge never reaches the other devices. Real strategies are driven through the real
// ConflictResolver rather than a stubbed decision.
import { ConflictApplier, ConflictDeps, conflictCopyPath } from '../../../../src/sync/conflict/ConflictApplier';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { MergeBaseRecorder } from '../../../../src/sync/session/MergeBaseRecorder';
import { TransferService } from '../../../../src/sync/transfer/TransferService';
import { ResolutionService } from '../../../../src/sync/resolution/ResolutionService';
import { MergeConfig } from '../../../../src/sync/ConflictResolver';
import { FileState, RemoteFileInfo, SyncSessionSummary } from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import { IUploadStrategy } from '../../../../src/sync/upload/IUploadStrategy';
import { passThroughLocalWrite, noPluginConflictRule } from '../../support/pluginPorts';
import type { PluginConflictRule } from '../../../../src/sync/plugins/PluginSyncCoordinator';

function summary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], pluginsNeedingRestart: [], errors: [],
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
  // Local file content and stat.
  local?: { content: string; mtime: number; size: number; ctime?: number };
  // Remote body the client returns.
  remoteBody?: string;
  // Merge base body, '' when unknown.
  mergeBase?: string;
  // Make the upload fail (transient) or report 'skipped'.
  upload?: 'ok' | 'skipped' | 'throw';
  oversize?: boolean;
}

function build(o: Opts = {}, over: Partial<ConflictDeps> = {}) {
  const local = o.local ?? { content: 'local body\n', mtime: 1000, size: 10 };
  let onDisk = local.content;

  const calls = {
    wrote: [] as string[],
    wroteBinary: [] as string[],
    // Third argument (mtime) seen by each write, in call order.
    wroteMtime: [] as Array<number | undefined>,
    wroteBinaryMtime: [] as Array<number | undefined>,
    // Fourth argument (ctime) seen by each text write, in call order.
    wroteCtime: [] as Array<number | undefined>,
    uploadMtime: [] as Array<number | undefined>,
    uploadOpts: [] as Array<{ ctime?: number } | undefined>,
    setFile: [] as FileState[],
    history: [] as string[],
    retries: [] as string[],
    mergeBase: [] as string[],
    captured: [] as string[],
    rootEtag: [] as Array<string | null>,
    conflicts: 0,
    reads: 0,
    warned: [] as string[],
    // Fourth argument (ctime) seen by each binary write, in call order.
    wroteBinaryCtime: [] as Array<number | undefined>,
    // Ordered trace of stat / write / setFile / align calls.
    events: [] as string[],
    aligned: [] as Array<{ client: unknown; remote: RemoteFileInfo }>,
    // Third argument (the caller's stat) seen by each align call, in call order.
    alignedStat: [] as unknown[],
  };

  const client = {
    downloadFile: async () => new TextEncoder().encode(o.remoteBody ?? 'remote body\n').buffer,
  } as unknown as IWebDAVClient;

  const uploadStrategy = {
    upload: async (_c: unknown, _p: string, _d: ArrayBuffer, mtime?: number, opts?: { ctime?: number }) => {
      calls.uploadMtime.push(mtime);
      calls.uploadOpts.push(opts);
      if (o.upload === 'throw') throw new Error('transient');
      return o.upload === 'skipped' ? 'skipped' : 'uploaded';
    },
  } as unknown as IUploadStrategy;

  const deps: ConflictDeps = {
    app: {} as unknown as ConflictDeps['app'],
    localAdapter: {
      stat: async () => { calls.events.push('stat'); return { size: local.size, mtime: local.mtime, ctime: local.ctime }; },
      read: async () => { calls.reads++; return onDisk; },
      readBinary: async () => new TextEncoder().encode(onDisk).buffer,
      atomicWrite: async (p: string, c: string, mtime?: number, ctime?: number) => {
        calls.events.push('write');
        calls.wrote.push(p); calls.wroteMtime.push(mtime); calls.wroteCtime.push(ctime); onDisk = c;
      },
      atomicWriteBinary: async (p: string, d: ArrayBuffer, mtime?: number, ctime?: number) => {
        calls.events.push('write');
        calls.wroteBinary.push(p); calls.wroteBinaryMtime.push(mtime); calls.wroteBinaryCtime.push(ctime); onDisk = new TextDecoder().decode(d);
      },
    } as unknown as ConflictDeps['localAdapter'],
    stateDB: {
      getFile: () => base(),
      setFile: (f: FileState) => { calls.events.push('setFile'); calls.setFile.push(f); },
      setRemoteRootEtag: (e: string | null) => { calls.rootEtag.push(e); },
    } as unknown as ConflictDeps['stateDB'],
    baseStore: { get: () => o.mergeBase ?? '' } as unknown as ConflictDeps['baseStore'],
    journal: Object.assign(new SyncJournal({}), {
      recordHistory: (p: string, op: string) => { calls.history.push(`${op}:${p}`); },
    }) as unknown as SyncJournal,
    mergeBase: {
      record: (p: string) => { calls.mergeBase.push(p); },
      recordBytes: (p: string) => { calls.mergeBase.push(p); },
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
    creationTime: {
      align: async (c: unknown, r: RemoteFileInfo, st?: unknown) => {
        calls.events.push('align'); calls.aligned.push({ client: c, remote: r }); calls.alignedStat.push(st);
      },
    },
    localWrite: passThroughLocalWrite,
    pluginConflictRule: noPluginConflictRule,
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
  const CLEAN_ARGS = ['note.md', 'merged body\n', true, remoteInfo(), 'old-remote', 'etag' as const] as const;

  it('records the merged body as the baseline once it reached the server', async () => {
    const { applier, conn, calls } = build({ upload: 'ok' });
    const s = summary();
    await applier.resolveByWrite(conn, ...CLEAN_ARGS, s);
    expect(s.mergedCount).toBe(1);
    expect(calls.setFile[0]).toMatchObject({ isConflicted: false, idType: 'sha256' });
    expect(calls.mergeBase).toEqual(['note.md']);
  });

  it('keeps the PREVIOUS baseline and stays conflicted when the push fails', async () => {
    // Recording the merged hash would make the next sync read "both sides unchanged" and take
    // the converged arm, so the merge would stay local forever.
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
    await applier.resolveByWrite(conn, 'note.md', 'markers\n', false, remoteInfo(), 'old-remote', 'etag', s);
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

describe('ConflictApplier.resolveByWrite — one merge time for disk, upload and state [SPEC:MT-4]', () => {
  const MERGE_TIME = 1_700_000_000_000;
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => { nowSpy = jest.spyOn(Date, 'now').mockReturnValue(MERGE_TIME); });
  afterEach(() => { nowSpy.mockRestore(); });

  it('passes the single captured Date.now() to atomicWrite, upload and the state mtime [SPEC:MT-4]', async () => {
    const { applier, conn, calls } = build({ upload: 'ok' });
    await applier.resolveByWrite(conn, 'note.md', 'merged\n', true, remoteInfo(), 'old-remote', 'etag', summary());
    expect(calls.wroteMtime).toEqual([MERGE_TIME]);
    expect(calls.uploadMtime).toEqual([MERGE_TIME]);
    expect(calls.setFile[0].mtime).toBe(MERGE_TIME);
  });

  it('reads the clock exactly once per call [SPEC:MT-4]', async () => {
    const { applier, conn } = build({ upload: 'ok' });
    await applier.resolveByWrite(conn, 'note.md', 'merged\n', true, remoteInfo(), 'old-remote', 'etag', summary());
    expect(nowSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores remote.lastModified and the prior local mtime, however extreme [SPEC:MT-4]', async () => {
    const { applier, conn, calls } = build({
      upload: 'ok', local: { content: 'x', mtime: 9_999_999_999_999, size: 1 },
    });
    await applier.resolveByWrite(
      conn, 'note.md', 'markers\n', false, remoteInfo({ lastModified: 1 }), 'old-remote', 'etag', summary(),
    );
    expect(calls.wroteMtime).toEqual([MERGE_TIME]);
    expect(calls.uploadMtime).toEqual([MERGE_TIME]);
    expect(calls.setFile[0].mtime).toBe(MERGE_TIME);
  });

  it('keeps the merge time in the state after a failed push [SPEC:MT-4]', async () => {
    const { applier, conn, calls } = build({ upload: 'throw' });
    await applier.resolveByWrite(conn, 'note.md', 'merged\n', true, remoteInfo(), 'old-remote', 'etag', summary());
    expect(calls.wroteMtime).toEqual([MERGE_TIME]);
    expect(calls.setFile[0].mtime).toBe(MERGE_TIME);
  });
});

describe('ConflictApplier.resolveByWrite — creation time [SPEC:CT-3]', () => {
  const OLD = 1_600_000_000_000;
  const NEW = 1_700_000_000_000;
  const remoteAt = (creationTime?: number) => remoteInfo({ creationTime });
  // [label, local ctime, server ctime, expected write ctime, expected upload ctime]
  const cases: Array<[string, number, number | undefined, number | undefined, number | undefined]> = [
    ['older local', OLD, NEW, OLD, OLD],
    ['older server', NEW, OLD, OLD, OLD],
    ['server undefined', OLD, undefined, OLD, undefined],
  ];

  for (const clean of [true, false]) {
    const kind = clean ? 'clean merge' : 'conflict markers';
    for (const [label, local, server, expectedWrite, expectedUpload] of cases) {
      it(`writes and uploads the older creation time: ${label}, ${kind} [SPEC:CT-3]`, async () => {
        const { applier, conn, calls } = build({ upload: 'ok', local: { content: 'x', mtime: 1, size: 1, ctime: local } });
        await applier.resolveByWrite(conn, 'note.md', 'merged\n', clean, remoteAt(server), 'old-remote', 'etag', summary());
        expect(calls.wroteCtime).toEqual([expectedWrite]);
        expect(calls.uploadOpts).toEqual([{ ctime: expectedUpload }]);
      });
    }

    it(`stats the local file before writing: ${kind} [SPEC:CT-3]`, async () => {
      const { applier, conn, calls } = build({ upload: 'ok', local: { content: 'x', mtime: 1, size: 1, ctime: OLD } });
      await applier.resolveByWrite(conn, 'note.md', 'merged\n', clean, remoteAt(NEW), 'old-remote', 'etag', summary());
      expect(calls.events.indexOf('stat')).toBeGreaterThanOrEqual(0);
      expect(calls.events.indexOf('stat')).toBeLessThan(calls.events.indexOf('write'));
    });
  }
});

describe('ConflictApplier.resolveByPreferRemote — the remote mtime goes into the write [SPEC:MT-1]', () => {
  const body = (t: string): ArrayBuffer => new TextEncoder().encode(t).buffer as ArrayBuffer;

  it('passes remote.lastModified as the third argument of atomicWriteBinary [SPEC:MT-1]', async () => {
    const { applier, calls } = build();
    await applier.resolveByPreferRemote(
      'a.txt', remoteInfo({ path: 'a.txt', lastModified: 1_577_836_800_000, size: 4 }), body('abcd'), 'r', 'etag', summary(),
    );
    expect(calls.wroteBinaryMtime).toEqual([1_577_836_800_000]);
  });

  it('omits the mtime (undefined) when the remote has none [SPEC:MT-1]', async () => {
    const { applier, calls } = build();
    await applier.resolveByPreferRemote(
      'a.txt', remoteInfo({ path: 'a.txt', lastModified: 0, size: 4 }), body('abcd'), 'r', 'etag', summary(),
    );
    expect(calls.wroteBinaryMtime).toEqual([undefined]);
  });
});

describe('ConflictApplier.resolveByPreferRemote — creation time [SPEC:CT-2]', () => {
  const body = (t: string): ArrayBuffer => new TextEncoder().encode(t).buffer as ArrayBuffer;
  const OLD = 1_600_000_000_000;
  const NEW = 1_700_000_000_000;
  const remoteAt = (creationTime?: number) => remoteInfo({ path: 'a.txt', size: 4, creationTime });

  it('writes the older of local and server creation time: older local [SPEC:CT-2]', async () => {
    const { applier, calls } = build({ local: { content: 'x', mtime: 1, size: 1, ctime: OLD } });
    await applier.resolveByPreferRemote('a.txt', remoteAt(NEW), body('abcd'), 'r', 'etag', summary());
    expect(calls.wroteBinaryCtime).toEqual([OLD]);
  });

  it('writes the older of local and server creation time: older server [SPEC:CT-2]', async () => {
    const { applier, calls } = build({ local: { content: 'x', mtime: 1, size: 1, ctime: NEW } });
    await applier.resolveByPreferRemote('a.txt', remoteAt(OLD), body('abcd'), 'r', 'etag', summary());
    expect(calls.wroteBinaryCtime).toEqual([OLD]);
  });

  it('writes the local creation time when the server value is undefined [SPEC:CT-2]', async () => {
    const { applier, calls } = build({ local: { content: 'x', mtime: 1, size: 1, ctime: OLD } });
    await applier.resolveByPreferRemote('a.txt', remoteAt(undefined), body('abcd'), 'r', 'etag', summary());
    expect(calls.wroteBinaryCtime).toEqual([OLD]);
  });

  it('stats the local file before writing [SPEC:CT-2]', async () => {
    const { applier, calls } = build({ local: { content: 'x', mtime: 1, size: 1, ctime: OLD } });
    await applier.resolveByPreferRemote('a.txt', remoteAt(NEW), body('abcd'), 'r', 'etag', summary());
    expect(calls.events.indexOf('stat')).toBeGreaterThanOrEqual(0);
    expect(calls.events.indexOf('stat')).toBeLessThan(calls.events.indexOf('write'));
  });

  it('aligns after recording the state when a client is passed [SPEC:CT-2]', async () => {
    const { applier, conn, calls } = build({ local: { content: 'x', mtime: 1, size: 1, ctime: OLD } });
    const remote = remoteAt(NEW);
    await applier.resolveByPreferRemote('a.txt', remote, body('abcd'), 'r', 'etag', summary(), conn.client);
    expect(calls.aligned).toEqual([{ client: conn.client, remote }]);
    expect(calls.events.indexOf('align')).toBeGreaterThan(calls.events.lastIndexOf('setFile'));
  });

  it('does not align when no client is passed [SPEC:CT-2]', async () => {
    const { applier, calls } = build({ local: { content: 'x', mtime: 1, size: 1, ctime: OLD } });
    await applier.resolveByPreferRemote('a.txt', remoteAt(NEW), body('abcd'), 'r', 'etag', summary());
    expect(calls.aligned).toEqual([]);
  });

  it('handleConflict passes conn.client on the prefer-remote path [SPEC:CT-2]', async () => {
    const { applier, conn, calls } = build({
      config: { autoMergeFileTypes: [], otherFileStrategy: 'remote-win' },
      local: { content: 'x', mtime: 1000, size: 1, ctime: OLD },
    });
    await applier.handleConflict(conn, 'a.txt', base('a.txt'), remoteAt(NEW), 'r', 'etag', summary());
    expect(calls.aligned.map((a) => a.client)).toEqual([conn.client]);
  });
});

describe('ConflictApplier.convergeIfIdentical — creation time [SPEC:CT-6]', () => {
  const OLD = 1_600_000_000_000;
  const stat = { size: 1, mtime: 1000, ctime: OLD };

  it('aligns once after setFile with the fresh local stat on a body-identical convergence [SPEC:CT-6]', async () => {
    const { applier, conn, calls } = build({ local: { content: 'x', mtime: 1000, size: 1, ctime: OLD }, remoteBody: 'x' });
    const remote = remoteInfo({ size: 1, creationTime: OLD + 1 });
    await applier.handleConflict(conn, 'note.md', base(), remote, 'r', 'etag', summary());
    expect(calls.aligned).toEqual([{ client: conn.client, remote }]);
    expect(calls.alignedStat).toEqual([stat]);
    expect(calls.events.indexOf('align')).toBeGreaterThan(calls.events.lastIndexOf('setFile'));
    expect(calls.conflicts).toBe(0);
  });

  it('does not converge or align before the overwrite when the bodies differ [SPEC:CT-6]', async () => {
    const { applier, conn, calls } = build({
      local: { content: 'x', mtime: 1000, size: 1, ctime: OLD }, remoteBody: 'y', config: { autoMergeFileTypes: [] },
    });
    await applier.handleConflict(conn, 'note.md', base(), remoteInfo({ size: 1 }), 'r', 'etag', summary());
    expect(calls.conflicts).toBe(1);
    expect(calls.aligned).toEqual([]);
  });

  it('accepts a null local stat without converging or aligning [SPEC:CT-6]', async () => {
    const { applier, conn, calls } = build();
    const priv = applier as unknown as {
      convergeIfIdentical(c: unknown, p: string, r: RemoteFileInfo, s: null): Promise<{ converged: boolean }>;
    };
    expect(await priv.convergeIfIdentical(conn, 'note.md', remoteInfo(), null)).toEqual({ converged: false });
    expect(calls.aligned).toEqual([]);
  });
});

describe('ConflictApplier.resolveByPreferLocal — creation time [SPEC:CT-4]', () => {
  const OLD = 1_600_000_000_000;
  const NEW = 1_700_000_000_000;

  it('uploads with the older of local and server creation time: older local [SPEC:CT-4]', async () => {
    const { applier, conn, calls } = build({ local: { content: 'x', mtime: 1, size: 1, ctime: OLD } });
    await applier.resolveByPreferLocal(conn, 'note.md', remoteInfo({ creationTime: NEW }), summary());
    expect(calls.uploadOpts).toEqual([{ ctime: OLD }]);
  });

  it('uploads with the older of local and server creation time: older server [SPEC:CT-4]', async () => {
    const { applier, conn, calls } = build({ local: { content: 'x', mtime: 1, size: 1, ctime: NEW } });
    await applier.resolveByPreferLocal(conn, 'note.md', remoteInfo({ creationTime: OLD }), summary());
    expect(calls.uploadOpts).toEqual([{ ctime: OLD }]);
  });

  it('sends no ctime when the server value is unknown [SPEC:CT-4]', async () => {
    const { applier, conn, calls } = build({ local: { content: 'x', mtime: 1, size: 1, ctime: OLD } });
    await applier.resolveByPreferLocal(conn, 'note.md', remoteInfo({ creationTime: undefined }), summary());
    expect(calls.uploadOpts).toEqual([{ ctime: undefined }]);
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
    // A size mismatch is deliberately not flagged: Obsidian's requestUrl on iOS reports a byte count that
    // drifts from content-length on multi-byte content, and flagging it refused legitimate downloads.
    // Only a genuinely empty body is anomalous; this stops the guard being widened to any mismatch.
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

describe('[SPEC:CPS-6] plugin conflict rules', () => {
  const PLUGIN_JS = '.obsidian/plugins/p/main.js';
  const PLUGIN_DATA = '.obsidian/plugins/p/data.json';
  const MERGE_CONFIG: Partial<MergeConfig> = { autoMergeFileTypes: ['md', 'js', 'json'], otherFileStrategy: 'latest-mtime' };
  const LOCAL = 'shared\nlocal line\n';
  const REMOTE = 'shared\nremote line\n';

  function run(path: string, rule: PluginConflictRule | null, localMtime: number, extra: Partial<ConflictDeps> = {}) {
    const h = build(
      { config: MERGE_CONFIG, local: { content: LOCAL, mtime: localMtime, size: 11 }, remoteBody: REMOTE },
      { pluginConflictRule: () => rule, ...extra },
    );
    const remote = remoteInfo({ path, size: REMOTE.length, lastModified: 2000 });
    return { ...h, remote, s: summary() };
  }

  it('1. force prefer-remote writes the remote body locally even when local is newer', async () => {
    const { applier, conn, calls, remote, s, diskContent } = run(PLUGIN_JS, { kind: 'force', action: 'prefer-remote' }, 5000);
    await applier.handleConflict(conn, PLUGIN_JS, base(PLUGIN_JS), remote, 'r', 'etag', s);
    expect(calls.wroteBinary).toEqual([PLUGIN_JS]);
    expect(diskContent()).toBe(REMOTE);
  });

  it('2. force prefer-local uploads even when local is older', async () => {
    const { applier, conn, calls, remote, s, diskContent } = run(PLUGIN_JS, { kind: 'force', action: 'prefer-local' }, 1000);
    await applier.handleConflict(conn, PLUGIN_JS, base(PLUGIN_JS), remote, 'r', 'etag', s);
    expect(calls.uploadMtime).toHaveLength(1);
    // The local body is pushed as is: nothing is merged or written locally.
    expect(calls.wrote).toEqual([]);
    expect(calls.wroteBinary).toEqual([]);
    expect(diskContent()).toBe(LOCAL);
  });

  it('3. force safe-hold flags a tracked file conflicted and writes nothing for an untracked one', async () => {
    const tracked = run(PLUGIN_JS, { kind: 'force', action: 'safe-hold' }, 1000);
    await tracked.applier.handleConflict(tracked.conn, PLUGIN_JS, base(PLUGIN_JS), tracked.remote, 'r', 'etag', tracked.s);
    expect(tracked.calls.setFile).toHaveLength(1);
    expect(tracked.calls.setFile[0]).toMatchObject({ isConflicted: true });
    expect(tracked.s.conflictedCount).toBe(1);

    const untracked = run(PLUGIN_JS, { kind: 'force', action: 'safe-hold' }, 1000);
    await untracked.applier.handleConflict(untracked.conn, PLUGIN_JS, undefined, untracked.remote, 'r', 'etag', untracked.s);
    expect(untracked.calls.setFile).toEqual([]);
  });

  it('4. strategy latest-mtime on main.js takes the newer remote without reading the local body', async () => {
    const { applier, conn, calls, remote, s, diskContent } = run(PLUGIN_JS, { kind: 'strategy', strategy: 'latest-mtime' }, 1000);
    await applier.handleConflict(conn, PLUGIN_JS, base(PLUGIN_JS), remote, 'r', 'etag', s);
    expect(calls.wroteBinary).toEqual([PLUGIN_JS]);
    expect(diskContent()).toBe(REMOTE);
    expect(calls.reads).toBe(0);
  });

  it('5. data.json follows otherFileStrategy and never gets conflict markers', async () => {
    const rule: PluginConflictRule = { kind: 'strategy', strategy: 'latest-mtime' };
    const { applier, conn, remote, s, diskContent } = run(PLUGIN_DATA, rule, 1000);
    await applier.handleConflict(conn, PLUGIN_DATA, base(PLUGIN_DATA), remote, 'r', 'etag', s);
    expect(diskContent()).not.toContain('<<<<<<<');
    expect(diskContent()).toBe(REMOTE);
  });

  it('6. a non-plugin .js file with no rule still goes through the merge path', async () => {
    const { applier, conn, calls, remote, s } = run('notes/a.js', null, 1000);
    await applier.handleConflict(conn, 'notes/a.js', base('notes/a.js'), remote, 'r', 'etag', s);
    expect(calls.wrote).toEqual(['notes/a.js']);
    expect(calls.wroteBinary).toEqual([]);
  });

  it('prefer-remote takes its mtime from localWrite and reports the write', async () => {
    const mtimeFor = jest.fn((_p: string, _m: number | undefined) => 4242);
    const written = jest.fn();
    const { applier, conn, calls, remote, s } = run(
      PLUGIN_JS, { kind: 'force', action: 'prefer-remote' }, 5000, { localWrite: { mtimeFor, written } },
    );
    await applier.handleConflict(conn, PLUGIN_JS, base(PLUGIN_JS), remote, 'r', 'etag', s);
    expect(mtimeFor).toHaveBeenCalledWith(PLUGIN_JS, 2000);
    expect(calls.wroteBinaryMtime).toEqual([4242]);
    expect(written).toHaveBeenCalledTimes(1);
    expect(written).toHaveBeenCalledWith(PLUGIN_JS);
  });
});

describe('ConflictApplier — the losing local body of a whole-file pick is kept as a conflict copy', () => {
  const nonMergeable = { autoMergeFileTypes: [], otherFileStrategy: 'latest-mtime' as const };

  it('names the copy after the file, keeping its folder and extension', () => {
    const at = new Date(2026, 9, 28, 15, 30, 12);
    expect(conflictCopyPath('dir/a.canvas', at)).toBe('dir/a (conflict 2026-10-28 153012).canvas');
    expect(conflictCopyPath('Makefile', at)).toBe('Makefile (conflict 2026-10-28 153012)');
    expect(conflictCopyPath('.env', at)).toBe('.env (conflict 2026-10-28 153012)');
  });

  it('prefer-remote writes the local body to a conflict copy before overwriting the file', async () => {
    const { applier, conn, calls } = build({
      config: nonMergeable,
      local: { content: 'older local', mtime: 1000, size: 5 },
      remoteBody: 'newer remote',
    });
    const written: Record<string, string> = {};
    const write = jest.fn(async (p: string, d: ArrayBuffer) => { written[p] = new TextDecoder().decode(d); });
    (applier as unknown as { deps: ConflictDeps }).deps.localAdapter.atomicWriteBinary = write;

    await applier.handleConflict(
      conn, 'a.txt', base('a.txt'), remoteInfo({ path: 'a.txt', lastModified: 9000, size: 12 }), 'r', 'etag', summary(),
    );

    const copy = Object.keys(written).find(p => /^a \(conflict \d{4}-\d{2}-\d{2} \d{6}\)\.txt$/.test(p));
    expect(copy).toBeDefined();
    expect(written[copy!]).toBe('older local');
    expect(written['a.txt']).toBe('newer remote');
    expect(write.mock.calls[0][0]).toBe(copy);
    expect(calls.history).toContain('remote-wins:a.txt');
  });

  it('leaves the local file untouched and conflicted when the copy cannot be written', async () => {
    const { applier, conn, calls, diskContent } = build({
      config: nonMergeable,
      local: { content: 'older local', mtime: 1000, size: 5 },
      remoteBody: 'newer remote',
    });
    (applier as unknown as { deps: ConflictDeps }).deps.localAdapter.atomicWriteBinary = jest.fn(async () => {
      throw new Error('ENOSPC');
    });
    const s = summary();

    await applier.handleConflict(
      conn, 'a.txt', base('a.txt'), remoteInfo({ path: 'a.txt', lastModified: 9000, size: 12 }), 'r', 'etag', s,
    );

    expect(diskContent()).toBe('older local');
    expect(calls.setFile[0]).toMatchObject({ isConflicted: true });
    expect(s.downloadedCount).toBe(0);
  });

  it('prefer-local keeps no copy: the server keeps the overwritten version in its history', async () => {
    const { applier, conn, calls } = build({
      config: nonMergeable,
      local: { content: 'newer local', mtime: 5000, size: 30 },
    });
    await applier.handleConflict(conn, 'a.txt', base('a.txt'), remoteInfo({ path: 'a.txt', lastModified: 1000 }), 'r', 'etag', summary());
    expect(calls.wroteBinary).toEqual([]);
  });
});
