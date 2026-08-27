// Direct tests for MirrorService (feature 074, addendum).
//
// No [SPEC:...] tags: MIR-* stays with the engine-level suites.
//
// Mirror is a one-way reset, so the thing worth pinning is what it refuses to do. A plan that could
// not be built reliably must produce ZERO deletions — never "the server listed nothing, so delete
// everything" — and the apply step must leave the state DB in a shape where the next ordinary sync
// sees no difference, or the reset simply undoes itself.
import { MirrorService, MirrorDeps } from '../../../../src/sync/mirror/MirrorService';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { MergeBaseRecorder } from '../../../../src/sync/session/MergeBaseRecorder';
import { TransferService } from '../../../../src/sync/transfer/TransferService';
import { DeletionService } from '../../../../src/sync/deletion/DeletionService';
import { LocalScanner } from '../../../../src/sync/scan/LocalScanner';
import { RemoteListingSource } from '../../../../src/sync/scan/RemoteListingSource';
import { MirrorPlan } from '../../../../src/sync/mirrorPlan';
import { FileState, RemoteFileInfo, SyncSessionSummary } from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';

const remote = (path: string, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo => ({
  path, fileId: `fid-${path}`, checksum: null, etag: '"e"', size: 10, lastModified: 1000, ...over,
});

function plan(over: Partial<MirrorPlan> = {}): MirrorPlan {
  return {
    ok: true, reason: undefined, skipCount: 0,
    downloads: [], deleteFiles: [], deleteDirs: [], remoteFiles: [],
    ...over,
  } as MirrorPlan;
}

const fstate = (path: string, localHash = 'h'): FileState => ({
  path, localHash, remoteId: 'r', idType: 'etag', size: 10, mtime: 1000,
  remoteFileId: null, isConflicted: false,
});

function build(over: Partial<MirrorDeps> = {}, tracked: FileState[] = []) {
  const calls = {
    downloaded: [] as string[],
    deleted: [] as string[],
    setFile: [] as string[],
    deleteFile: [] as string[],
    deleteDir: [] as string[],
    droppedBase: [] as string[],
    status: [] as string[],
    progress: [] as Array<[number, number]>,
    complete: [] as Array<number[]>,
  };
  let processed = 0;
  let total = 0;

  const client = {
    getFiles: async () => [] as RemoteFileInfo[],
    recalcChecksum: async () => null,
  } as unknown as IWebDAVClient;

  const deps: MirrorDeps = {
    app: {
      vault: { getAllFolders: () => [] },
    } as unknown as MirrorDeps['app'],
    localAdapter: {
      stat: async () => ({ size: 10, mtime: 1000 }),
      readBinary: async () => new ArrayBuffer(10),
    } as unknown as MirrorDeps['localAdapter'],
    stateDB: {
      getFile: (p: string) => tracked.find((f) => f.path === p),
      setFile: (f: FileState) => { calls.setFile.push(f.path); },
      getAllFiles: () => tracked,
      deleteFile: (p: string) => { calls.deleteFile.push(p); },
      deleteDir: (p: string) => { calls.deleteDir.push(p); },
      setRemoteRootEtag: () => { /* noop */ },
      setSyncToken: () => { /* noop */ },
    } as unknown as MirrorDeps['stateDB'],
    statusBar: {
      setStatus: (s: string) => { calls.status.push(s); },
      setProgress: (d: number, t: number) => { calls.progress.push([d, t]); },
      setSyncComplete: (...a: number[]) => { calls.complete.push(a); },
    } as unknown as MirrorDeps['statusBar'],
    journal: new SyncJournal({}),
    mergeBase: {
      record: () => { /* noop */ },
      drop: (p: string) => { calls.droppedBase.push(p); },
    } as unknown as MergeBaseRecorder,
    transfer: {
      downloadFile: async (
        _c: IWebDAVClient, r: RemoteFileInfo, _id: string, _t: string, s: SyncSessionSummary,
      ) => { calls.downloaded.push(r.path); s.downloadedCount++; },
    } as unknown as TransferService,
    deletion: {
      processRemoteDeletion: async (p: string, s: SyncSessionSummary) => {
        calls.deleted.push(p); s.downloadedCount++;
      },
    } as unknown as DeletionService,
    localScanner: { collectLocalStats: async () => { /* noop */ } } as unknown as LocalScanner,
    remoteListing: { resolveRemoteChecksums: async () => { /* noop */ } } as unknown as RemoteListingSource,
    progress: {
      begin: (t: number) => { processed = 0; total = t; },
      tick: () => { processed = Math.min(processed + 1, total); return processed; },
    },
    enumerateIncludedConfigPaths: async () => [],
    isSystemExcluded: () => false,
    connect: async () => client,
    ...over,
  };

  return { mirror: new MirrorService(deps), client, calls, ticks: () => processed };
}

describe('MirrorService.applyRemoteMirror — the refusal gate', () => {
  it('does nothing at all when the plan is not ok', async () => {
    const { mirror, client, calls } = build();
    const result = await mirror.applyRemoteMirror(
      client, plan({ ok: false, reason: 'listing failed', deleteFiles: ['a.md'], downloads: [remote('b.md')] }),
    );
    expect(calls.deleted).toEqual([]);
    expect(calls.downloaded).toEqual([]);
    expect(result).toEqual({ downloaded: 0, deleted: 0, skipped: 0, errors: [] });
  });

  it('reports the plan\'s skip count even on the refusal path', async () => {
    const { mirror, client } = build();
    const result = await mirror.applyRemoteMirror(client, plan({ ok: false, skipCount: 7 }));
    expect(result.skipped).toBe(7);
  });
});

describe('MirrorService.applyRemoteMirror — applying the plan', () => {
  it('downloads, deletes files, then deletes folders', async () => {
    const { mirror, client, calls } = build();
    const result = await mirror.applyRemoteMirror(client, plan({
      downloads: [remote('a.md')], deleteFiles: ['old.md'], deleteDirs: ['OldDir'],
      remoteFiles: [remote('a.md')],
    }));
    expect(calls.downloaded).toEqual(['a.md']);
    expect(calls.deleted).toEqual(['old.md', 'OldDir']);
    expect(calls.deleteDir).toEqual(['OldDir']);
    expect(result).toMatchObject({ downloaded: 1, deleted: 2 });
  });

  it('isolates a per-path failure instead of abandoning the rest', async () => {
    const { mirror, client, calls } = build({
      transfer: {
        downloadFile: async (_c: IWebDAVClient, r: RemoteFileInfo) => {
          if (r.path === 'bad.md') throw new Error('boom');
          calls.downloaded.push(r.path);
        },
      } as unknown as TransferService,
    });
    const result = await mirror.applyRemoteMirror(client, plan({
      downloads: [remote('ok.md'), remote('bad.md')],
    }));
    expect(calls.downloaded).toEqual(['ok.md']);
    expect(result.errors).toEqual([{ path: 'bad.md', message: 'boom' }]);
  });

  it('counts a download only when the transfer actually reported one', async () => {
    // The size guard returns without downloading; that must not be counted as a success.
    const { mirror, client } = build({
      transfer: { downloadFile: async () => { /* skipped by the size guard */ } } as unknown as TransferService,
    });
    const result = await mirror.applyRemoteMirror(client, plan({ downloads: [remote('huge.bin')] }));
    expect(result.downloaded).toBe(0);
  });
});

describe('MirrorService.applyRemoteMirror — progress reporting', () => {
  it('opens with syncing, ticks per item, and closes with a result', async () => {
    const { mirror, client, calls } = build();
    await mirror.applyRemoteMirror(client, plan({ deleteFiles: ['gone.md'] }));
    expect(calls.status).toEqual(['syncing']);
    expect(calls.progress[0]).toEqual([0, 1]);
    expect(calls.complete).toHaveLength(1);
  });

  it('advances the progress even when no onProgress callback is supplied', async () => {
    // Regression guard: folding the tick into `onProgress?.(...)` makes it conditional on the
    // callback existing, because optional chaining does not evaluate its arguments when the callee
    // is nullish. The status bar then silently stops moving for every caller that passes none.
    const { mirror, client, ticks } = build();
    await mirror.applyRemoteMirror(client, plan({
      downloads: [remote('a.md')], deleteFiles: ['b.md'],
    }));
    expect(ticks()).toBe(2);
  });

  it('reports the same counts to the callback as to the status bar', async () => {
    const seen: Array<[number, number]> = [];
    const { mirror, client } = build();
    await mirror.applyRemoteMirror(
      client, plan({ deleteFiles: ['a.md', 'b.md'] }), (d, t) => seen.push([d, t]),
    );
    expect(seen).toEqual([[0, 2], [1, 2], [2, 2]]);
  });

  it('does not open a progress range when there is nothing to do', async () => {
    const { mirror, client, calls } = build();
    await mirror.applyRemoteMirror(client, plan());
    expect(calls.progress).toEqual([]); // no setProgress(0, 0)
    expect(calls.complete).toHaveLength(1); // but the surface is still closed
  });
});

describe('MirrorService.applyRemoteMirror — converging the state DB', () => {
  it('tracks a skipped file so the next sync does not misread it as a conflict', async () => {
    // Skipped = content already matched, so downloadFile never ran and never recorded it.
    const { mirror, client, calls } = build();
    await mirror.applyRemoteMirror(client, plan({
      skipCount: 1, downloads: [], remoteFiles: [remote('same.md', { checksum: 'abc' })],
    }));
    expect(calls.setFile).toEqual(['same.md']);
  });

  it('does not re-record a file the download already tracked', async () => {
    const { mirror, client, calls } = build();
    const r = remote('new.md');
    await mirror.applyRemoteMirror(client, plan({ downloads: [r], remoteFiles: [r] }));
    expect(calls.setFile).toEqual([]);
  });

  it('drops a tracked file the remote no longer has, along with its merge base', async () => {
    const { mirror, client, calls } = build({}, [fstate('stale.md')]);
    await mirror.applyRemoteMirror(client, plan({ remoteFiles: [] }));
    expect(calls.deleteFile).toEqual(['stale.md']);
    expect(calls.droppedBase).toEqual(['stale.md']);
  });

  it('leaves excluded paths alone on both convergence passes', async () => {
    const { mirror, client, calls } = build(
      { isSystemExcluded: (p) => p.startsWith('.obsidian/') },
      [fstate('.obsidian/workspace.json')],
    );
    await mirror.applyRemoteMirror(client, plan({
      remoteFiles: [remote('.obsidian/other.json'), remote('a.md')],
    }));
    expect(calls.deleteFile).toEqual([]);            // not dropped
    expect(calls.setFile).toEqual(['a.md']);          // not tracked
  });

  it('forces a real full scan next sync', async () => {
    const rootEtag: Array<string | null> = [];
    const tokens: string[] = [];
    const { mirror, client } = build({
      stateDB: {
        getFile: () => undefined,
        setFile: () => { /* noop */ },
        getAllFiles: () => [],
        deleteFile: () => { /* noop */ },
        deleteDir: () => { /* noop */ },
        setRemoteRootEtag: (e: string | null) => rootEtag.push(e),
        setSyncToken: (t: string) => tokens.push(t),
      } as unknown as MirrorDeps['stateDB'],
    });
    await mirror.applyRemoteMirror(client, plan());
    expect(rootEtag).toEqual([null]);
    expect(tokens).toEqual(['']);
  });
});

describe('MirrorService.planRemoteMirror — a plan that cannot be trusted deletes nothing', () => {
  it('returns an unusable plan when the connection fails', async () => {
    const { mirror } = build({ connect: async () => { throw new Error('offline'); } });
    const p = await mirror.planRemoteMirror();
    expect(p.ok).toBe(false);
    expect(p.reason).toContain('offline');
    expect(p.deleteFiles).toEqual([]);
    expect(p.deleteDirs).toEqual([]);
  });

  it('returns an unusable plan when the remote listing fails', async () => {
    const { mirror } = build({
      connect: async () => ({ getFiles: async () => { throw new Error('PROPFIND 500'); } }) as unknown as IWebDAVClient,
    });
    const p = await mirror.planRemoteMirror();
    expect(p.ok).toBe(false);
    expect(p.reason).toContain('PROPFIND 500');
    expect(p.deleteFiles).toEqual([]);
  });

  it('reports each phase as it goes so a long plan is not a frozen dialog', async () => {
    const phases: string[] = [];
    const { mirror } = build();
    await mirror.planRemoteMirror((label) => phases.push(label));
    expect(phases[0]).toMatch(/Connecting/);
    expect(phases).toContain('Reading the remote file list…');
    expect(phases[phases.length - 1]).toMatch(/local files/);
  });

  it('injects the enabled config-sync paths into the local side', async () => {
    const { mirror } = build({ enumerateIncludedConfigPaths: async () => ['.obsidian/bookmarks.json'] });
    const p = await mirror.planRemoteMirror();
    // Nothing remote, so the config path is local-only ⇒ a deletion candidate.
    expect(p.deleteFiles).toContain('.obsidian/bookmarks.json');
  });

  it('only hashes a local file when the remote carries a checksum to compare against', async () => {
    let reads = 0;
    const { mirror } = build({
      localAdapter: {
        stat: async () => ({ size: 10, mtime: 1000 }),
        readBinary: async () => { reads++; return new ArrayBuffer(10); },
      } as unknown as MirrorDeps['localAdapter'],
      enumerateIncludedConfigPaths: async () => ['a.md'],
      connect: async () => ({
        getFiles: async () => [remote('a.md', { checksum: null })],
        recalcChecksum: async () => null,
      }) as unknown as IWebDAVClient,
    });
    await mirror.planRemoteMirror();
    expect(reads).toBe(0); // remote has no checksum ⇒ hashing would be wasted I/O
  });
});
