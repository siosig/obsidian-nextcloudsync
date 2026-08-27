// Direct tests for TransferService (feature 074, addendum).
//
// No [SPEC:...] tags: URE-*, WSF-* and DSG-* stay with the engine-level suites.
//
// One file crossing, in each direction. The interesting parts are the guards on either side of the
// transfer rather than the transfer itself: a lock that is held by someone else must not be treated
// as a failure, and a body the server contradicts must never reach the disk.
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

function summary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

const remote = (over: Partial<RemoteFileInfo> = {}): RemoteFileInfo => ({
  path: 'note.md', fileId: 'fid', checksum: null, etag: '"e1"', size: 11, lastModified: 2000, ...over,
});

interface Opts {
  localContent?: string | null;
  remoteBody?: ArrayBuffer;
  upload?: 'uploaded' | 'skipped';
  /** What lockFile does: a token, or an error class to throw. */
  lock?: 'token' | 'none' | 'locked' | 'unsupported' | 'network' | 'other';
  hasLocking?: boolean;
  oversize?: boolean;
  base?: FileState;
}

function build(o: Opts = {}, over: Partial<TransferDeps> = {}) {
  const calls = {
    put: [] as Array<{ path: string; ifMatch?: string | null }>,
    lockAttempts: 0,
    unlocked: [] as string[],
    wrote: [] as string[],
    setMtime: [] as string[],
    setFile: [] as FileState[],
    history: [] as string[],
    retries: [] as string[],
    mergeBase: [] as string[],
    notices: [] as string[],
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
    upload: async (_c: unknown, path: string, _d: unknown, _m: number, opts?: { ifMatchEtag?: string | null }) => {
      calls.put.push({ path, ifMatch: opts?.ifMatchEtag });
      return o.upload ?? 'uploaded';
    },
  } as unknown as IUploadStrategy;

  const deps: TransferDeps = {
    localAdapter: {
      stat: async () => (onDisk == null ? null : { size: onDisk.length, mtime: 1234 }),
      readBinary: async () => new TextEncoder().encode(onDisk ?? '').buffer,
      atomicWriteBinary: async (p: string, d: ArrayBuffer) => {
        calls.wrote.push(p); onDisk = new TextDecoder().decode(d);
      },
      setMtime: async (p: string) => { calls.setMtime.push(p); },
    } as unknown as TransferDeps['localAdapter'],
    stateDB: {
      getFile: () => o.base,
      setFile: (f: FileState) => { calls.setFile.push(f); },
    } as unknown as TransferDeps['stateDB'],
    journal: Object.assign(new SyncJournal({}), {
      recordHistory: (p: string, op: string) => { calls.history.push(`${op}:${p}`); },
    }) as unknown as SyncJournal,
    mergeBase: {
      record: (p: string) => { calls.mergeBase.push(p); },
      drop: () => { /* noop */ },
    } as unknown as MergeBaseRecorder,
    maxFileSizeMB: () => (o.oversize ? 0.000001 : 100),
    hasFilesLocking: () => o.hasLocking === true,
    queueRetry: (p: string) => { calls.retries.push(p); },
    notify: (m: string) => { calls.notices.push(m); },
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
    // Feature 064 (C-4): keeping the PRE-upload remote id made every following sync read "remote
    // changed" and download the file we had just uploaded, forever.
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

  it('records nothing when the strategy skipped the upload', async () => {
    const { transfer, client, uploadStrategy, calls } = build({ upload: 'skipped' });
    const s = summary();
    await transfer.uploadFile(client, uploadStrategy, 'note.md', 'h', 'r', 'etag', remote(), s);
    expect(s.uploadedCount).toBe(0);
    expect(calls.setFile).toEqual([]);
    expect(calls.retries).toEqual([]); // a size skip is permanent, not transient
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
  // Feature 033 pinned file locking off for every user: lost-update safety is the always-on If-Match
  // precondition, without the LOCK/UNLOCK round-trips. The mechanism below is retained but never
  // engaged from the sync path, so these tests pin the ABSENCE of lock traffic rather than pretending
  // the retry-and-backoff code runs. If the fixed flag is ever turned back on, they fail — which is
  // the signal to write the tests that path would then need.

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
  it('writes the body, preserves the remote mtime, and converges the state DB', async () => {
    const body = new TextEncoder().encode('remote body').buffer;
    const { transfer, client, calls, diskContent } = build({ remoteBody: body });
    const s = summary();
    await transfer.downloadFile(client, remote({ size: body.byteLength }), 'rid', 'etag', s);
    expect(diskContent()).toBe('remote body');
    expect(calls.setMtime).toEqual(['note.md']);
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

  it('skips an oversized remote BEFORE the GET, permanently and without an error', async () => {
    // Re-fetching would fail the same way every sync until the cap is raised, which self-heals.
    const { transfer, client, calls } = build({ oversize: true });
    const s = summary();
    await transfer.downloadFile(client, remote(), 'rid', 'etag', s);
    expect(calls.downloads).toBe(0);
    expect(calls.wrote).toEqual([]);
    expect(calls.retries).toEqual([]);
    expect(s.errorCount).toBe(0);
    expect(calls.notices[0]).toContain('too large to download');
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
    // Spec 025: Obsidian's requestUrl on iOS reports a byte count that drifts from content-length on
    // multi-byte text. Flagging any mismatch refused legitimate downloads outright (0.7.7).
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

  it('does not stamp an mtime the server did not give', async () => {
    const body = new TextEncoder().encode('b').buffer;
    const { transfer, client, calls } = build({ remoteBody: body });
    await transfer.downloadFile(client, remote({ size: 1, lastModified: 0 }), 'rid', 'etag', summary());
    expect(calls.setMtime).toEqual([]);
  });
});
