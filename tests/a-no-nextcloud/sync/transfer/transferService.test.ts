// Direct tests for TransferService; no [SPEC:...] tags (URE-*, WSF-* and DSG-* stay with the engine-level
// suites). One file crossing in each direction; the interesting parts are the guards on either side: a lock
// held by someone else must not be treated as a failure, and a body the server contradicts must never reach
// the disk.
import { TransferService, TransferDeps } from '../../../../src/sync/transfer/TransferService';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { MergeBaseRecorder } from '../../../../src/sync/session/MergeBaseRecorder';
import {
  FileState, RemoteFileInfo, SyncSessionSummary,
  FileLockedError, FeatureUnsupportedError, NetworkError,
} from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import { IUploadStrategy } from '../../../../src/sync/upload/IUploadStrategy';
import { sha256 } from '../../../../src/util/hash';
import { passThroughLocalWrite } from '../../support/pluginPorts';

function summary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], pluginsNeedingRestart: [], errors: [], oversizeSkippedPaths: new Set(),
  };
}

const remote = (over: Partial<RemoteFileInfo> = {}): RemoteFileInfo => ({
  path: 'note.md', fileId: 'fid', checksum: null, etag: '"e1"', size: 11, lastModified: 2000, ...over,
});

interface Opts {
  localContent?: string | null;
  remoteBody?: ArrayBuffer;
  upload?: 'uploaded' | 'skipped';
  // What lockFile does: a token, or an error class to throw.
  lock?: 'token' | 'none' | 'locked' | 'unsupported' | 'network' | 'other';
  hasLocking?: boolean;
  oversize?: boolean;
  base?: FileState;
  // Creation time (ms) the local file has before the write; omitted = the stat carries none.
  localCtime?: number;
}

function build(o: Opts = {}, over: Partial<TransferDeps> = {}) {
  const calls = {
    put: [] as Array<{ path: string; ifMatch?: string | null }>,
    lockAttempts: 0,
    unlocked: [] as string[],
    wrote: [] as string[],
    writeMtime: [] as Array<number | undefined>,
    writeCtime: [] as Array<number | undefined>,
    uploadOpts: [] as Array<Record<string, unknown> | undefined>,
    order: [] as string[],
    setFile: [] as FileState[],
    history: [] as string[],
    retries: [] as string[],
    mergeBase: [] as string[],
    logs: [] as string[],
    downloads: 0,
  };
  let onDisk = o.localContent ?? 'local body';

  const client = {
    lockFile: async () => {
      calls.lockAttempts++;
      switch (o.lock) {
        case 'locked': throw new FileLockedError('note.md');
        case 'unsupported': throw new FeatureUnsupportedError('locking');
        case 'network': throw new NetworkError(500, '');
        case 'other': throw new Error('unexpected');
        case 'none': return null;
        default: return 'tok';
      }
    },
    unlockFile: async (p: string) => { calls.unlocked.push(p); },
    downloadFile: async () => {
      calls.downloads++;
      return o.remoteBody ?? new TextEncoder().encode('remote body').buffer;
    },
  } as unknown as IWebDAVClient;

  const uploadStrategy = {
    upload: async (_c: unknown, path: string, _d: unknown, _m: number, opts?: { ifMatchEtag?: string | null; ctime?: number }) => {
      calls.uploadOpts.push(opts);
      calls.put.push({ path, ifMatch: opts?.ifMatchEtag });
      return o.upload ?? 'uploaded';
    },
  } as unknown as IUploadStrategy;

  const deps: TransferDeps = {
    localAdapter: {
      stat: async () => (onDisk == null ? null : { size: onDisk.length, mtime: 1234, ctime: o.localCtime }),
      readBinary: async () => new TextEncoder().encode(onDisk ?? '').buffer,
      atomicWriteBinary: async (p: string, d: ArrayBuffer, mtime?: number, ctime?: number) => {
        calls.order.push('write'); calls.wrote.push(p); calls.writeMtime.push(mtime); calls.writeCtime.push(ctime); onDisk = new TextDecoder().decode(d);
      },
    } as unknown as TransferDeps['localAdapter'],
    stateDB: {
      getFile: () => o.base,
      setFile: (f: FileState) => { calls.order.push('setFile'); calls.setFile.push(f); },
    } as unknown as TransferDeps['stateDB'],
    localWrite: passThroughLocalWrite,
    // The real journal records the oversize skip and writes its one log line through this logger.
    journal: Object.assign(new SyncJournal({ logger: { log: async (m: string) => { calls.logs.push(m); } } }), {
      recordHistory: (p: string, op: string) => { calls.history.push(`${op}:${p}`); },
    }) as unknown as SyncJournal,
    mergeBase: {
      record: (p: string) => { calls.mergeBase.push(p); },
      recordBytes: (p: string) => { calls.mergeBase.push(p); },
      drop: () => { /* noop */ },
    } as unknown as MergeBaseRecorder,
    maxFileSizeMB: () => (o.oversize ? 0.000001 : 100),
    hasFilesLocking: () => o.hasLocking === true,
    // This suite models a Nextcloud server (checksums come back from PROPFIND), which is the branch that keeps
    // recording the local hash and makes no extra request after an upload.
    clientReportsChecksums: () => true,
    queueRetry: (p: string) => { calls.retries.push(p); },
    ...over,
  };

  return {
    transfer: new TransferService(deps), client, uploadStrategy, calls,
    diskContent: () => onDisk,
    setLocal: (c: string | null) => { onDisk = c as string; },
  };
}

describe('TransferService.uploadFile', () => {
  it('does nothing when the local file has vanished', async () => {
    const { transfer, client, uploadStrategy, calls, setLocal } = build();
    setLocal(null);
    await transfer.uploadFile(client, uploadStrategy, 'note.md', 'h', 'r', 'etag', remote(), summary());
    expect(calls.put).toEqual([]);
  });

  it('sends the known remote etag as a precondition so a changed remote is rejected', async () => {
    const { transfer, client, uploadStrategy, calls } = build();
    await transfer.uploadFile(client, uploadStrategy, 'note.md', 'h', 'r', 'etag', remote({ etag: '"r9"' }), summary());
    expect(calls.put).toEqual([{ path: 'note.md', ifMatch: '"r9"' }]);
  });

  it('sends no precondition for a file that is not on the server yet', async () => {
    const { transfer, client, uploadStrategy, calls } = build();
    await transfer.uploadFile(client, uploadStrategy, 'new.md', 'h', 'r', 'etag', remote({ etag: null }), summary());
    expect(calls.put[0].ifMatch).toBeNull();
  });

  it('records the hash of what the server now holds, not what it held before', async () => {
    // Keeping the PRE-upload remote id made every following sync read "remote changed" and download the file
    // we had just uploaded, forever.
    const { transfer, client, uploadStrategy, calls } = build();
    const s = summary();
    await transfer.uploadFile(client, uploadStrategy, 'note.md', 'local-hash', 'OLD-REMOTE', 'etag', remote(), s);
    expect(s.uploadedCount).toBe(1);
    expect(calls.setFile[0]).toMatchObject({ remoteId: 'local-hash', idType: 'sha256', isConflicted: false });
    expect(calls.history).toEqual(['uploaded:note.md']);
    expect(calls.mergeBase).toEqual(['note.md']);
  });

  it('stamps the post-write stat signature so the next sync can skip re-hashing', async () => {
    const { transfer, client, uploadStrategy, calls } = build();
    await transfer.uploadFile(client, uploadStrategy, 'note.md', 'h', 'r', 'etag', remote(), summary());
    expect(calls.setFile[0]).toMatchObject({ localMtime: 1234 });
  });

  it('records nothing when the strategy skipped the upload [SPEC:OSN-1]', async () => {
    const { transfer, client, uploadStrategy, calls } = build({ upload: 'skipped' });
    const s = summary();
    await transfer.uploadFile(client, uploadStrategy, 'note.md', 'h', 'r', 'etag', remote(), s);
    expect(s.uploadedCount).toBe(0);
    expect(calls.setFile).toEqual([]);
    expect(calls.retries).toEqual([]); // a size skip is permanent, not transient
    // The skip itself is recorded once for the end-of-sync notice: the path joins the summary set and one
    // log line carries the direction, the measured size and the limit.
    expect(s.oversizeSkippedPaths.has('note.md')).toBe(true);
    expect(calls.logs.filter((l) => l.startsWith('size-limit: skipped upload ('))).toEqual([
      'size-limit: skipped upload (10B > 100MB) → note.md',
    ]);
  });

  it('propagates an upload failure rather than recording a half-success', async () => {
    const { transfer, client, calls } = build();
    const failing = {
      upload: async () => { throw new Error('PUT failed'); },
    } as unknown as IUploadStrategy;
    await expect(
      transfer.uploadFile(client, failing, 'note.md', 'h', 'r', 'etag', remote(), summary()),
    ).rejects.toThrow('PUT failed');
    expect(calls.setFile).toEqual([]);
    expect(calls.history).toEqual([]);
  });
});

describe('TransferService — locking is fixed OFF, and that is the point', () => {
  // File locking is pinned off for every user: lost-update safety is the always-on If-Match precondition,
  // without LOCK/UNLOCK round-trips. The lock mechanism is retained but never engaged from the sync path, so
  // these tests pin the ABSENCE of lock traffic. If the fixed flag is turned back on they fail, which is the
  // signal to write the tests that path would then need.

  it('issues no lock request even when the server advertises the capability', async () => {
    const { transfer, client, uploadStrategy, calls } = build({ hasLocking: true });
    await transfer.uploadFile(client, uploadStrategy, 'note.md', 'h', 'r', 'etag', remote(), summary());
    expect(calls.lockAttempts).toBe(0);
    expect(calls.unlocked).toEqual([]);
    expect(calls.put).toHaveLength(1); // the upload still happens, guarded by If-Match instead
  });

  it('hands every caller a null token without touching the network', async () => {
    // Conflict resolution, clean-side writes and directory deletes all take this same lock.
    const { transfer, client, calls } = build({ hasLocking: true });
    expect(await transfer.acquireLock(client, 'note.md')).toBeNull();
    expect(calls.lockAttempts).toBe(0);
  });

  it('releasing a null token is a no-op rather than an unlock request', async () => {
    const { transfer, client, calls } = build({ hasLocking: true });
    await transfer.releaseLock(client, 'note.md', null);
    expect(calls.unlocked).toEqual([]);
  });

  it('still releases a token it was actually given', async () => {
    const { transfer, client, calls } = build();
    await transfer.releaseLock(client, 'note.md', 'tok');
    expect(calls.unlocked).toEqual(['note.md']);
  });
});

describe('TransferService.downloadFile', () => {
  it('writes the body, passes the remote mtime to the write, and converges the state DB [SPEC:MT-1]', async () => {
    const body = new TextEncoder().encode('remote body').buffer;
    const { transfer, client, calls, diskContent } = build({ remoteBody: body });
    const s = summary();
    await transfer.downloadFile(client, remote({ size: body.byteLength }), 'rid', 'etag', s);
    expect(diskContent()).toBe('remote body');
    expect(calls.writeMtime).toEqual([2000]);
    expect(s.downloadedCount).toBe(1);
    expect(calls.history).toEqual(['downloaded:note.md']);
    expect(calls.setFile[0]).toMatchObject({ remoteId: 'rid', idType: 'etag', isConflicted: false });
    expect(calls.mergeBase).toEqual(['note.md']);
  });

  it('records the hash of the bytes it actually received', async () => {
    const body = new TextEncoder().encode('remote body').buffer;
    const { transfer, client, calls } = build({ remoteBody: body });
    await transfer.downloadFile(client, remote({ size: body.byteLength }), 'rid', 'etag', summary());
    expect(calls.setFile[0].localHash).toBe(await sha256(body));
  });

  it('skips an oversized remote BEFORE the GET, permanently and without an error [SPEC:OSN-1]', async () => {
    // Re-fetching would fail the same way every sync until the cap is raised, which self-heals.
    const { transfer, client, calls } = build({ oversize: true });
    const s = summary();
    await transfer.downloadFile(client, remote(), 'rid', 'etag', s);
    expect(calls.downloads).toBe(0);
    expect(calls.wrote).toEqual([]);
    expect(calls.retries).toEqual([]);
    expect(s.errorCount).toBe(0);
    // Recorded for the end-of-sync notice instead of a per-file notice (remote() is 11 B; the oversize cap
    // is 0.000001 MB).
    expect(s.oversizeSkippedPaths.has('note.md')).toBe(true);
    expect(calls.logs.filter((l) => l.startsWith('size-limit: skipped download ('))).toEqual([
      'size-limit: skipped download (11B > 0.000001MB) → note.md',
    ]);
  });

  it('refuses an EMPTY body for a file advertised as non-empty, keeping local intact', async () => {
    const { transfer, client, calls, diskContent } = build({ remoteBody: new ArrayBuffer(0), base: { isConflicted: false } as FileState });
    const s = summary();
    await transfer.downloadFile(client, remote({ size: 20 }), 'rid', 'etag', s);
    expect(calls.wrote).toEqual([]);
    expect(diskContent()).toBe('local body');
    expect(s.errorCount).toBe(1);
    expect(calls.retries).toEqual(['note.md']);
    expect(calls.setFile[0].isConflicted).toBe(true); // surfaced in the UI
  });

  it('ACCEPTS a non-zero length that disagrees with the advertised size', async () => {
    // Obsidian's requestUrl on iOS reports a byte count that drifts from content-length on multi-byte text;
    // flagging any mismatch refused legitimate downloads outright.
    const body = new TextEncoder().encode('x').buffer;
    const { transfer, client, calls } = build({ remoteBody: body });
    const s = summary();
    await transfer.downloadFile(client, remote({ size: 9999 }), 'rid', 'etag', s);
    expect(s.errorCount).toBe(0);
    expect(calls.wrote).toEqual(['note.md']);
  });

  it('accepts a legitimately empty remote file', async () => {
    const { transfer, client, calls } = build({ remoteBody: new ArrayBuffer(0) });
    const s = summary();
    await transfer.downloadFile(client, remote({ size: 0 }), 'rid', 'etag', s);
    expect(s.errorCount).toBe(0);
    expect(calls.wrote).toEqual(['note.md']);
  });

  it('does not stamp an mtime the server did not give [SPEC:MT-3]', async () => {
    const body = new TextEncoder().encode('b').buffer;
    const { transfer, client, calls } = build({ remoteBody: body });
    await transfer.downloadFile(client, remote({ size: 1, lastModified: 0 }), 'rid', 'etag', summary());
    expect(calls.writeMtime).toEqual([undefined]);
    expect(calls.writeMtime[0]).toBeUndefined();
  });
});

describe('[SPEC:CPS-19] downloadFile writes through LocalWritePort', () => {
  const fakePort = () => ({ mtimeFor: jest.fn(() => 42), written: jest.fn() });

  it('writes with the mtime the port chooses and reports the write once, after it', async () => {
    const body = new TextEncoder().encode('remote body').buffer;
    const localWrite = fakePort();
    const { transfer, client, calls } = build({ remoteBody: body }, { localWrite });
    const r = remote({ size: body.byteLength, lastModified: 2000 });
    localWrite.written.mockImplementation(() => { expect(calls.wrote).toEqual(['note.md']); });
    await transfer.downloadFile(client, r, 'rid', 'etag', summary());
    expect(localWrite.mtimeFor).toHaveBeenCalledWith('note.md', 2000);
    expect(calls.writeMtime).toEqual([42]);
    expect(localWrite.written).toHaveBeenCalledTimes(1);
    expect(localWrite.written).toHaveBeenCalledWith('note.md');
  });

  it('passes undefined to the port when the server gave no mtime', async () => {
    const body = new TextEncoder().encode('b').buffer;
    const localWrite = fakePort();
    const { transfer, client } = build({ remoteBody: body }, { localWrite });
    await transfer.downloadFile(client, remote({ size: 1, lastModified: 0 }), 'rid', 'etag', summary());
    expect(localWrite.mtimeFor).toHaveBeenCalledWith('note.md', undefined);
  });

  it('does not report a write when the local file already has the same content', async () => {
    const body = new TextEncoder().encode('same').buffer;
    const localWrite = fakePort();
    const { transfer, client, calls } = build({ remoteBody: body, localContent: 'same' }, { localWrite });
    await transfer.downloadFile(client, remote({ size: body.byteLength }), 'rid', 'etag', summary());
    expect(calls.wrote).toEqual([]);
    expect(localWrite.written).toHaveBeenCalledTimes(0);
  });
});

describe('[SPEC:CT-2] downloadFile writes the earlier of the local and server creation times', () => {
  const T_NEW = 1700000000000;
  const T_OLD = 1690000000000;
  const bodyOf = () => new TextEncoder().encode('remote body').buffer;

  async function ctimeArg(o: Opts, creationTime: number | undefined): Promise<number | undefined> {
    const { transfer, client, calls } = build({ remoteBody: bodyOf(), ...o });
    await transfer.downloadFile(client, remote({ size: 11, creationTime }), 'rid', 'etag', summary());
    expect(calls.writeCtime).toHaveLength(1);
    return calls.writeCtime[0];
  }

  it('passes the server value for a new download (nothing on disk before)', async () => {
    expect(await ctimeArg({ localContent: null }, T_NEW)).toBe(T_NEW);
  });

  it('keeps the older local creation time when overwriting', async () => {
    expect(await ctimeArg({ localCtime: T_OLD }, T_NEW)).toBe(T_OLD);
  });

  it('takes the server value when the local creation time is newer', async () => {
    expect(await ctimeArg({ localCtime: T_NEW }, T_OLD)).toBe(T_OLD);
  });

  it('keeps the pre-write local value when the server gave none', async () => {
    expect(await ctimeArg({ localCtime: T_OLD }, undefined)).toBe(T_OLD);
  });

  it('passes undefined (write time applies) when neither side is valid', async () => {
    expect(await ctimeArg({}, undefined)).toBeUndefined();
    expect(await ctimeArg({ localCtime: 0 }, 0)).toBeUndefined();
  });

  it('leaves the mtime argument as before (a data.json gets the write time as mtime, the creation time still aligns) [SPEC:CPS-19]', async () => {
    const localWrite = { mtimeFor: jest.fn(() => 5000), written: jest.fn() };
    const { transfer, client, calls } = build({ remoteBody: bodyOf(), localContent: null }, { localWrite });
    await transfer.downloadFile(
      client, remote({ path: 'plugins/p/data.json', size: 11, lastModified: 2000, creationTime: T_NEW }), 'rid', 'etag', summary(),
    );
    expect(calls.writeMtime).toEqual([5000]);
    expect(calls.writeCtime).toEqual([T_NEW]);
  });
});

describe('[SPEC:CT-6] downloadFile aligns the creation time after the write', () => {
  it('calls align(client, remote) once with no third argument, after setFile', async () => {
    const align = jest.fn(async (_c: IWebDAVClient, _r: RemoteFileInfo) => { /* replaced below to log into the shared order */ });
    const { transfer, client, calls } = build({}, { creationTime: { align } });
    align.mockImplementation(async () => { calls.order.push('align'); });
    const r = remote({ size: 11, creationTime: 1700000000000 });
    await transfer.downloadFile(client, r, 'rid', 'etag', summary());
    expect(align).toHaveBeenCalledTimes(1);
    expect(align.mock.calls[0]).toHaveLength(2);
    expect(align).toHaveBeenCalledWith(client, r);
    expect(calls.order).toEqual(['write', 'setFile', 'align']);
  });

  it('does not throw when no aligner is wired', async () => {
    const { transfer, client, calls } = build({});
    await expect(transfer.downloadFile(client, remote({ size: 11, creationTime: 1700000000000 }), 'rid', 'etag', summary())).resolves.toBeUndefined();
    expect(calls.wrote).toEqual(['note.md']);
  });
});

describe('[SPEC:CT-6] downloadFile converges the creation time when the body is identical', () => {
  it('calls align(client, remote, localStat) once after setFile and does not write the body', async () => {
    const body = new TextEncoder().encode('same').buffer;
    const align = jest.fn(async (_c: IWebDAVClient, _r: RemoteFileInfo, _s?: unknown) => { /* logged below */ });
    const { transfer, client, calls } = build({ remoteBody: body, localContent: 'same', localCtime: 1700000000000 }, { creationTime: { align } });
    align.mockImplementation(async () => { calls.order.push('align'); });
    const r = remote({ size: body.byteLength, creationTime: 1690000000000 });
    await transfer.downloadFile(client, r, 'rid', 'etag', summary());
    expect(calls.wrote).toEqual([]);
    expect(align).toHaveBeenCalledTimes(1);
    expect(align).toHaveBeenCalledWith(client, r, { size: 4, mtime: 1234, ctime: 1700000000000 });
    expect(calls.order).toEqual(['setFile', 'align']);
  });

  it('does not throw when no aligner is wired', async () => {
    const body = new TextEncoder().encode('same').buffer;
    const { transfer, client, calls } = build({ remoteBody: body, localContent: 'same' });
    await expect(transfer.downloadFile(client, remote({ size: body.byteLength }), 'rid', 'etag', summary())).resolves.toBeUndefined();
    expect(calls.wrote).toEqual([]);
  });
});

describe('[SPEC:CT-4] uploadFile sends the creation time with the PUT', () => {
  const T_NEW = 1700000000000;
  const T_OLD = 1690000000000;

  async function optsOf(localCtime: number | undefined, over: Partial<RemoteFileInfo>) {
    const { transfer, client, uploadStrategy, calls } = build({ localCtime });
    await transfer.uploadFile(client, uploadStrategy, 'note.md', 'h', 'r', 'etag', remote(over), summary());
    expect(calls.uploadOpts).toHaveLength(1);
    return calls.uploadOpts[0];
  }

  it('passes exactly { ifMatchEtag, ctime } as the fifth argument', async () => {
    const opts = await optsOf(T_OLD, { etag: '"r9"', creationTime: T_NEW });
    expect(opts).toEqual({ ifMatchEtag: '"r9"', ctime: T_OLD });
  });

  it('sends ctime undefined when the server value is unknown', async () => {
    const opts = await optsOf(T_OLD, { creationTime: undefined });
    expect(opts).toEqual({ ifMatchEtag: '"e1"', ctime: undefined });
  });

  it('sends the local value when the server holds 0 and the local value is valid', async () => {
    const opts = await optsOf(T_NEW, { creationTime: 0 });
    expect(opts?.ctime).toBe(T_NEW);
  });

  it('sends the server value when it is older than the local one', async () => {
    const opts = await optsOf(T_NEW, { creationTime: T_OLD });
    expect(opts?.ctime).toBe(T_OLD);
  });

  it('sends the local value when it is older than the server one', async () => {
    const opts = await optsOf(T_OLD, { creationTime: T_NEW });
    expect(opts?.ctime).toBe(T_OLD);
  });

  it('sends ctime undefined when neither side is valid', async () => {
    const opts = await optsOf(undefined, { creationTime: 0 });
    expect(opts?.ctime).toBeUndefined();
  });
});
